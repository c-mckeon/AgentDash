// The Pseudocode tab: a folder tree of the repository, and for the chosen file
// its plain-language pseudocode beside the real code. Clicking a pseudocode
// chunk highlights the lines it describes. Everything comes from
// data/code.json, built by tools/build-pseudocode.ts; nothing else is loaded.

(() => {
  const FIRST_FILE = "agent/loop.ts";
  const tree = document.getElementById("code-tree");
  const detail = document.getElementById("code-detail");
  const switcher = document.getElementById("code-level");
  let files = null;
  let current = null;
  // "overview" explains each part of a file; "detail" is the function-by-function plan.
  let level = "overview";
  /** The chunks on screen: the current file's, at the current level. */
  let shown = [];

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------------------------------------------------------------- tree

  /** Turns the flat list of paths into nested folders. */
  function nest(paths) {
    const root = { folders: new Map(), files: [] };
    for (const path of paths) {
      const parts = path.split("/");
      let folder = root;
      for (const part of parts.slice(0, -1)) {
        if (!folder.folders.has(part)) folder.folders.set(part, { folders: new Map(), files: [] });
        folder = folder.folders.get(part);
      }
      folder.files.push(path);
    }
    return root;
  }

  function drawFolder(folder) {
    const list = make("ul");
    for (const [name, child] of [...folder.folders].sort(([a], [b]) => a.localeCompare(b))) {
      const item = make("li");
      const fold = make("details");
      fold.open = true;
      fold.append(make("summary", "", `${name}/`), drawFolder(child));
      item.append(fold);
      list.append(item);
    }
    for (const path of folder.files) {
      const item = make("li");
      const button = make("button", "file", path.split("/").pop());
      button.type = "button";
      if (!files.find((entry) => entry.path === path).chunks.length) button.classList.add("bare");
      button.dataset.path = path;
      button.addEventListener("click", () => showFile(path, true));
      item.append(button);
      list.append(item);
    }
    return list;
  }

  // ---------------------------------------------------------------- one file

  function showFile(path, scroll) {
    const file = files.find((entry) => entry.path === path);
    if (!file) return;
    current = file;
    shown = level === "detail" ? file.detail : file.chunks;
    for (const button of tree.querySelectorAll("button.file")) {
      button.setAttribute("aria-current", String(button.dataset.path === path));
    }

    const lines = file.text.replace(/\n$/, "").split("\n");
    const code = make("div", "code-pane");
    const inner = make("div", "code-lines");
    lines.forEach((text, index) => {
      const row = make("div", "line");
      row.dataset.n = index + 1;
      row.append(make("span", "n", String(index + 1)), make("span", "t", text || " "));
      inner.append(row);
    });
    code.append(inner);
    // Clicking a line of code selects the chunk that explains it.
    inner.addEventListener("click", (event) => {
      const row = event.target.closest(".line");
      if (!row) return;
      const n = Number(row.dataset.n);
      const index = shown.findIndex((chunk) => chunk.ranges.some(([from, to]) => n >= from && n <= to));
      if (index !== -1) selectChunk(index, false);
    });

    const pseudo = make("div", "pseudo-pane");
    // The detailed level opens with the plan: what the file needs and how its parts connect.
    if (level === "detail" && file.plan) pseudo.append(make("div", "plan", file.plan));
    shown.forEach((chunk, index) => {
      const card = make("button", "chunk");
      card.type = "button";
      const where = chunk.ranges.map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`)).join(", ");
      card.append(make("span", "chunk-title", chunk.title), make("span", "chunk-lines", `lines ${where}`), make("span", "chunk-text", chunk.text));
      card.addEventListener("click", () => selectChunk(index, true));
      pseudo.append(card);
    });

    if (!shown.length) pseudo.append(make("p", "note", "No pseudocode has been written for this file yet."));

    const head = make("div", "code-head");
    head.append(make("h2", "", path), make("p", "", file.summary));
    const columns = make("div", "code-columns");
    const left = make("div");
    const right = make("div");
    left.append(make("h3", "", level === "detail" ? "Detailed pseudocode" : "High-level explanation"), pseudo);
    right.append(make("h3", "", `Actual code · ${lines.length} lines`), code);
    columns.append(left, right);
    detail.replaceChildren(head, columns);
    if (scroll) detail.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function selectChunk(index, scrollCode) {
    const chunk = shown[index];
    const cards = detail.querySelectorAll(".chunk");
    cards.forEach((card, at) => card.setAttribute("aria-pressed", String(at === index)));
    const pane = detail.querySelector(".code-pane");
    let first = null;
    for (const row of pane.querySelectorAll(".line")) {
      const n = Number(row.dataset.n);
      const lit = chunk.ranges.some(([from, to]) => n >= from && n <= to);
      row.classList.toggle("lit", lit);
      if (lit && !first) first = row;
    }
    // Scroll only the pane that was not clicked, and never the page itself.
    if (scrollCode && first) {
      pane.scrollTo({ top: first.offsetTop - 40, behavior: "smooth" });
    } else if (!scrollCode) {
      const list = detail.querySelector(".pseudo-pane");
      list.scrollTo({ top: cards[index].offsetTop - 12, behavior: "smooth" });
    }
  }

  // ---------------------------------------------------------------- level switch

  switcher.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-level]");
    if (!button || button.dataset.level === level) return;
    level = button.dataset.level;
    for (const other of switcher.querySelectorAll("button")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
    if (current) showFile(current.path, false);
  });

  // ---------------------------------------------------------------- loading

  // The data is sizeable, so it is fetched the first time the tab is opened.
  document.addEventListener("tabshown", async (event) => {
    if (event.detail !== "pseudocode" || files) return;
    files = [];
    try {
      const response = await fetch("data/code.json");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      files = (await response.json()).files;
    } catch (error) {
      files = null;
      tree.replaceChildren(make("p", "note", `Could not load the repository view (${error.message}).`));
      return;
    }
    tree.replaceChildren(drawFolder(nest(files.map((file) => file.path))));
    showFile(files.some((file) => file.path === FIRST_FILE) ? FIRST_FILE : files[0].path, false);
  });
})();
