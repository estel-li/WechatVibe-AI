"use strict";
// Stateless label renderers shared by the local and API display paths.
// The factory receives its DOM and formatting dependencies and owns no account,
// task or cache state; it never reads localStorage, fetches or sets timers.
(function () {
  function create(dependencies) {
    const element = dependencies.element;
    // One template for both sources: an emotion line followed by an intent line.
    function render(view, messageId) {
      const row = element("div", "inline-intent-row");
      if (!view.emotions.length && !view.intents.length) return row;
      const line = element("div", `intent-line${view.emotions.length ? " emotion-line" : ""}${view.intents.length ? " intent-score-line" : ""}`);
      if (view.emotions.length) {
        line.appendChild(element("span", "intent-label", "情绪"));
        for (const [index, entry] of view.emotions.slice(0, 1).entries()) {
          const candidate = element("span", `intent-item${index === 0 ? " primary" : ""}`);
          candidate.appendChild(element("span", "intent-name", String(entry.label).trim()));
          line.appendChild(candidate);
        }
      }
      if (view.intents.length) {
        line.appendChild(element("span", "intent-label intent-label-intent", "意图"));
        for (const [index, entry] of view.intents.slice(0, 1).entries()) {
          const item = element("span", `intent-item${index === 0 ? " primary" : ""}`);
          item.appendChild(element("span", "intent-name", String(entry.label).trim()));
          line.appendChild(item);
        }
      }
      row.appendChild(line);
      return row;
    }
    // Compatibility helpers keep the old single-line entry points without a second template.
    function appendScoreLine(container, label, scores, messageId, emotion = false) {
      if (!scores.length) return;
      const view = emotion
        ? { emotions: scores.slice(0, 3).map(({ item }) => ({ label: String(item.label).trim() })), intents: [] }
        : { emotions: [], intents: scores.slice(0, 3).map(({ item }) => ({ label: String(item.label).trim() })) };
      const row = render(view, messageId);
      for (const line of [...row.children]) {
        line.children[0].textContent = label;
        container.appendChild(line);
      }
    }
    function appendIntentLine(container, candidates) {
      if (!candidates.length) return;
      const view = { emotions: [], intents: candidates.slice(0, 3).map((candidate) => ({
        label: String(candidate.label).trim(),
      })) };
      const row = render(view, "");
      for (const line of [...row.children]) container.appendChild(line);
    }
    return { render, renderApiInsightResult: render, appendScoreLine, appendIntentLine };
  }
  window.MessageLabels = Object.freeze({ create });
})();
