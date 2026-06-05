(function (global) {
  "use strict";

  const SAMPLE_SRT = `1
00:00:01,000 --> 00:00:03,200
  Welcome   to this messy subtitle demo.

2
00:00:03,000 --> 00:00:10,900
This caption overlaps the previous one and it is also much too long for a comfortable single line in most video layouts.

bad-number
00:00:11,100 --> 00:00:11,500
Too fast

4
00:00:12,000 --> 00:00:13,700

5
00:00:14,000 --> 00:00:17,000
Final caption with    extra spaces.`;

  function normalizeNewlines(text) {
    return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  }

  function parseTimestamp(value) {
    const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2}):(\d{2})([,.](\d{1,3}))?$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const ms = Number((match[5] || "0").padEnd(3, "0").slice(0, 3));
    if (minutes > 59 || seconds > 59) return null;
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
  }

  function formatTimestamp(ms) {
    const safe = Math.max(0, Math.round(ms));
    const hours = Math.floor(safe / 3600000);
    const minutes = Math.floor((safe % 3600000) / 60000);
    const seconds = Math.floor((safe % 60000) / 1000);
    const milli = safe % 1000;
    return [
      String(hours).padStart(2, "0"),
      String(minutes).padStart(2, "0"),
      String(seconds).padStart(2, "0")
    ].join(":") + "," + String(milli).padStart(3, "0");
  }

  function cleanCaptionText(lines) {
    return lines
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();
  }

  function wrapText(text, maxChars) {
    const limit = Math.max(16, Number(maxChars) || 42);
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let current = "";
    words.forEach((word) => {
      if (!current) {
        current = word;
        return;
      }
      if ((current + " " + word).length <= limit) {
        current += " " + word;
        return;
      }
      lines.push(current);
      current = word;
    });
    if (current) lines.push(current);
    return lines.length ? lines : [""];
  }

  function parseCaptions(text) {
    const source = normalizeNewlines(text).replace(/^WEBVTT[^\n]*\n+/i, "");
    if (!source) return [];
    const blocks = source.split(/\n{2,}/);
    const cues = [];
    blocks.forEach((block, blockIndex) => {
      const lines = block.split("\n").map((line) => line.trim()).filter((line) => line.length);
      if (!lines.length) return;

      let timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex === -1) {
        cues.push({
          index: blockIndex + 1,
          startMs: null,
          endMs: null,
          text: cleanCaptionText(lines),
          raw: block,
          parseError: "Missing timestamp line"
        });
        return;
      }

      const timing = lines[timingIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
      const startMs = parseTimestamp(timing[0]);
      const endMs = parseTimestamp(timing[1]);
      const textLines = lines.slice(timingIndex + 1);
      cues.push({
        index: blockIndex + 1,
        startMs,
        endMs,
        text: cleanCaptionText(textLines),
        raw: block,
        parseError: startMs === null || endMs === null ? "Invalid timestamp" : ""
      });
    });
    return cues;
  }

  function cleanCaptions(text, options) {
    const settings = Object.assign({
      maxChars: 42,
      minDurationMs: 800,
      maxDurationMs: 7000
    }, options || {});
    const cues = parseCaptions(text);
    const issues = [];

    const cleaned = cues.map((cue, i) => {
      const duration = cue.startMs !== null && cue.endMs !== null ? cue.endMs - cue.startMs : null;
      if (cue.parseError) issues.push(`Cue ${i + 1}: ${cue.parseError}.`);
      if (duration !== null && duration <= 0) issues.push(`Cue ${i + 1}: end time is not after start time.`);
      if (duration !== null && duration < settings.minDurationMs) issues.push(`Cue ${i + 1}: duration ${duration}ms is shorter than ${settings.minDurationMs}ms.`);
      if (duration !== null && duration > settings.maxDurationMs) issues.push(`Cue ${i + 1}: duration ${duration}ms is longer than ${settings.maxDurationMs}ms.`);
      if (!cue.text) issues.push(`Cue ${i + 1}: empty caption text.`);
      if (i > 0 && cue.startMs !== null && cues[i - 1].endMs !== null && cue.startMs < cues[i - 1].endMs) {
        issues.push(`Cue ${i + 1}: overlaps previous cue by ${cues[i - 1].endMs - cue.startMs}ms.`);
      }
      const wrapped = wrapText(cue.text, settings.maxChars);
      wrapped.forEach((line) => {
        if (line.length > settings.maxChars) issues.push(`Cue ${i + 1}: line exceeds ${settings.maxChars} characters.`);
      });
      return {
        number: i + 1,
        startMs: cue.startMs,
        endMs: cue.endMs,
        duration,
        lines: wrapped,
        validTiming: cue.startMs !== null && cue.endMs !== null && cue.endMs > cue.startMs
      };
    });

    const output = cleaned.map((cue) => {
      const timing = cue.validTiming
        ? `${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}`
        : "00:00:00,000 --> 00:00:00,000";
      return `${cue.number}\n${timing}\n${cue.lines.join("\n")}`;
    }).join("\n\n");

    const totalDuration = cleaned.reduce((sum, cue) => sum + (cue.duration && cue.duration > 0 ? cue.duration : 0), 0);
    return {
      output,
      issues,
      metrics: {
        cues: cleaned.length,
        issues: issues.length,
        totalDurationMs: totalDuration,
        averageDurationMs: cleaned.length ? Math.round(totalDuration / cleaned.length) : 0
      }
    };
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function renderReport(result) {
    const metrics = document.getElementById("metrics");
    const issues = document.getElementById("issues");
    if (!metrics || !issues) return;
    metrics.innerHTML = [
      ["Cues", result.metrics.cues],
      ["Issues", result.metrics.issues],
      ["Total sec", (result.metrics.totalDurationMs / 1000).toFixed(1)],
      ["Avg ms", result.metrics.averageDurationMs]
    ].map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("");
    issues.innerHTML = result.issues.length
      ? result.issues.map((issue) => `<li>${issue}</li>`).join("")
      : "<li>No issues found.</li>";
  }

  function initUi() {
    const input = document.getElementById("inputText");
    const output = document.getElementById("outputText");
    const maxChars = document.getElementById("maxChars");
    const minDuration = document.getElementById("minDuration");
    const maxDuration = document.getElementById("maxDuration");
    const cleanButton = document.getElementById("cleanButton");
    const loadSample = document.getElementById("loadSample");
    const copyOutput = document.getElementById("copyOutput");
    const fileInput = document.getElementById("fileInput");
    const downloadSrt = document.getElementById("downloadSrt");
    const downloadReport = document.getElementById("downloadReport");
    let lastResult = cleanCaptions("");

    function runClean() {
      lastResult = cleanCaptions(input.value, {
        maxChars: Number(maxChars.value),
        minDurationMs: Number(minDuration.value),
        maxDurationMs: Number(maxDuration.value)
      });
      output.value = lastResult.output;
      renderReport(lastResult);
    }

    cleanButton.addEventListener("click", runClean);
    loadSample.addEventListener("click", () => {
      input.value = SAMPLE_SRT;
      runClean();
    });
    copyOutput.addEventListener("click", async () => {
      if (!output.value) return;
      await navigator.clipboard.writeText(output.value);
      copyOutput.textContent = "Copied";
      setTimeout(() => {
        copyOutput.textContent = "Copy";
      }, 1000);
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      input.value = await file.text();
      runClean();
    });
    downloadSrt.addEventListener("click", () => {
      if (output.value) downloadText("cleaned-captions.srt", output.value);
    });
    downloadReport.addEventListener("click", () => {
      const report = [
        `Cues: ${lastResult.metrics.cues}`,
        `Issues: ${lastResult.metrics.issues}`,
        `Total duration ms: ${lastResult.metrics.totalDurationMs}`,
        "",
        ...lastResult.issues
      ].join("\n");
      downloadText("caption-quality-report.txt", report);
    });
    renderReport(lastResult);
  }

  const api = {
    SAMPLE_SRT,
    parseTimestamp,
    formatTimestamp,
    parseCaptions,
    cleanCaptions,
    wrapText
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.SrtCleaner = api;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initUi);
    } else {
      initUi();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);

