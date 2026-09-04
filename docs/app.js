const reportUrl = "data/demo-run.json";
function text(element, value) {
  if (element) element.textContent = String(value);
}
function eventClass(type) {
  if (type.startsWith("policy.")) return "policy";
  if (type.startsWith("approval.")) return "approval";
  if (type.startsWith("tool.")) return "tool";
  return "system";
}
function renderEventDetail(event) {
  text(document.querySelector("#event-title"), event.type);
  const metadata = document.querySelector("#event-metadata");
  metadata.replaceChildren();
  for (const [label, value] of [
    ["Sequence", event.sequence],
    ["Actor", event.actor],
    ["Time", event.occurredAt],
    ["Event ID", event.eventId],
  ]) {
    const term = document.createElement("dt");
    const definition = document.createElement("dd");
    text(term, label);
    text(definition, value);
    metadata.append(term, definition);
  }
  text(document.querySelector("#event-json code"), JSON.stringify(event.data, null, 2));
}
function renderTimeline(events, filter = "all") {
  const timeline = document.querySelector("#timeline");
  timeline.replaceChildren();
  const selected =
    filter === "all" ? events : events.filter((event) => eventClass(event.type) === filter);
  for (const event of selected) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "event-button";
    button.type = "button";
    const sequence = document.createElement("span");
    sequence.className = "event-sequence";
    text(sequence, String(event.sequence).padStart(2, "0"));
    const type = document.createElement("span");
    type.className = "event-type";
    const typeName = document.createElement("span");
    const actor = document.createElement("small");
    text(typeName, event.type);
    text(actor, event.actor);
    type.append(typeName, actor);
    const marker = document.createElement("span");
    marker.className = `event-class ${eventClass(event.type)}`;
    button.append(sequence, type, marker);
    button.addEventListener("click", () => {
      document.querySelectorAll(".event-button").forEach((node) => {
        node.classList.remove("selected");
      });
      button.classList.add("selected");
      renderEventDetail(event);
    });
    item.append(button);
    timeline.append(item);
  }
  timeline.querySelector("button")?.click();
}
function renderGraph(graph) {
  const svg = document.querySelector("#knowledge-graph");
  const namespace = "http://www.w3.org/2000/svg";
  const positions = {
    "case-0142": [310, 145],
    "party-0901": [115, 75],
    "evidence-doc-0088": [515, 70],
    "evidence-signal-0021": [505, 230],
  };
  svg.replaceChildren();
  for (const edge of graph.edges) {
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to) continue;
    const line = document.createElementNS(namespace, "line");
    line.setAttribute("x1", from[0]);
    line.setAttribute("y1", from[1]);
    line.setAttribute("x2", to[0]);
    line.setAttribute("y2", to[1]);
    line.setAttribute("class", "graph-edge");
    svg.append(line);
  }
  for (const node of graph.nodes) {
    const position = positions[node.id];
    if (!position) continue;
    const group = document.createElementNS(namespace, "g");
    group.setAttribute("class", `graph-node ${node.kind}`);
    group.setAttribute("transform", `translate(${position[0]} ${position[1]})`);
    const circle = document.createElementNS(namespace, "circle");
    circle.setAttribute("r", node.kind === "case" ? "52" : "44");
    const kind = document.createElementNS(namespace, "text");
    kind.setAttribute("class", "kind");
    kind.setAttribute("y", "-6");
    text(kind, node.kind.toUpperCase());
    const label = document.createElementNS(namespace, "text");
    label.setAttribute("y", "13");
    text(label, node.id.replace("evidence-", ""));
    group.append(circle, kind, label);
    svg.append(group);
  }
}
function render(report) {
  text(document.querySelector("#run-status"), report.run.status.replaceAll("_", " "));
  text(document.querySelector("#metric-events"), report.metrics.events);
  text(document.querySelector("#metric-approvals"), report.metrics.approvals);
  text(document.querySelector("#metric-retries"), report.metrics.retries);
  text(document.querySelector("#ledger-hash"), report.events.at(-1)?.hash ?? "no events");
  const controls = document.querySelector("#controls");
  report.controls.forEach((control, index) => {
    const card = document.createElement("article");
    card.className = "control-card";
    const number = document.createElement("span");
    number.className = "control-number";
    const title = document.createElement("h3");
    const result = document.createElement("p");
    text(number, String(index + 1).padStart(2, "0"));
    text(title, control.name);
    text(result, control.result);
    card.append(number, title, result);
    controls.append(card);
  });
  renderTimeline(report.events);
  renderGraph(report.graph);
  const evaluations = document.querySelector("#evaluation-list");
  for (const evaluation of report.evaluation.cases) {
    const card = document.createElement("article");
    card.className = "evaluation-card";
    const status = document.createElement("span");
    status.className = "evaluation-status";
    const title = document.createElement("h3");
    const list = document.createElement("ul");
    list.className = "assertion-list";
    text(status, evaluation.passed ? "✓ Passed" : "× Failed");
    text(title, evaluation.name);
    for (const assertion of evaluation.assertions) {
      const item = document.createElement("li");
      const label = document.createElement("span");
      const result = document.createElement("strong");
      text(label, assertion.label);
      text(result, JSON.stringify(assertion.actual));
      item.append(label, result);
      list.append(item);
    }
    card.append(status, title, list);
    evaluations.append(card);
  }
  document.querySelectorAll(".filter").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".filter").forEach((node) => {
        node.classList.remove("active");
      });
      button.classList.add("active");
      renderTimeline(report.events, button.dataset.filter);
    });
  });
}
fetch(reportUrl)
  .then((response) => {
    if (!response.ok) throw new Error(`Report request failed: ${response.status}`);
    return response.json();
  })
  .then(render)
  .catch((error) => {
    text(document.querySelector("#run-status"), "unavailable");
    console.error(error);
  });
