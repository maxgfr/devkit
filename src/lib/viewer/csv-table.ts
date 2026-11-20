// The CSV / TSV table of the data viewer: a sticky header, sort by column, a row filter, the header
// row guess with a toggle, and rows built in chunks.
import { type CsvTable, csvTable, type Delimiter, delimiterName, filterRowIndexes, sortRowIndexes } from "../formats/csv";
import { CHUNK, isHttpUrl } from "../json-viewer";
import { type Body, linkTo, type ViewCtx } from "./ctx";

export interface CsvBody extends Body {
  /** Toolbar controls of the table: the header toggle and the size. */
  controls: HTMLElement[];
  table(): CsvTable;
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function createCsvTable(
  ctx: ViewCtx,
  text: string,
  opts: { delimiter?: Delimiter; preferTab?: boolean; table?: CsvTable },
): CsvBody {
  const { el, button, view } = ctx;
  let table = opts.table ?? csvTable(text, opts);
  const guessed = table.hasHeader;
  let sort: { column: number; direction: "asc" | "desc" } | null = null;
  let query = "";
  let order: number[] = [];
  let rendered = 0;
  let tbody: HTMLTableSectionElement | null = null;
  let more: HTMLButtonElement | null = null;
  let ragged = new Set<number>();

  const headerBtn = button("Header row", undefined, "Use the first row as column names");
  const size = el("span", "meta");
  const describe = () => {
    headerBtn.setAttribute("aria-pressed", String(table.hasHeader));
    headerBtn.title = `Use the first row as column names (devkit guessed ${guessed ? "it is" : "it is not"} a header: a heuristic)`;
    size.textContent = `${fmt(table.rows.length)} row${table.rows.length === 1 ? "" : "s"} × ${fmt(table.columns.length)} column${table.columns.length === 1 ? "" : "s"}, ${delimiterName(table.delimiter)}-separated`;
  };

  const cell = (value: string): HTMLTableCellElement => {
    const td = el("td");
    if (isHttpUrl(value.trim())) td.append(linkTo(ctx, value.trim(), value));
    else td.textContent = value;
    if (value.length > 40) td.title = value;
    return td;
  };

  const renderMore = () => {
    if (!tbody) return;
    more?.remove();
    const end = Math.min(order.length, rendered + CHUNK);
    for (let k = rendered; k < end; k++) {
      const i = order[k]!;
      const row = table.rows[i]!;
      const tr = el("tr");
      const line = table.lines[i]!;
      const rn = el("th", "rn", String(i + 1));
      rn.scope = "row";
      rn.title = `Line ${line} of the file`;
      tr.append(rn, ...row.map(cell));
      if (ragged.has(line)) {
        tr.classList.add("ragged");
        tr.title = `Line ${line} has ${table.raw[i]} field${table.raw[i] === 1 ? "" : "s"}, ${table.hasHeader ? "the header has" : "the widest row has"} ${table.fields}`;
      }
      tbody.append(tr);
    }
    rendered = end;
    if (end < order.length) {
      const left = order.length - end;
      more = button(`Show ${fmt(Math.min(CHUNK, left))} more rows (${fmt(left)} left)`, "more");
      more.addEventListener("click", renderMore);
      view.append(more);
    } else more = null;
  };

  const render = () => {
    view.replaceChildren();
    const filtered = filterRowIndexes(table.rows, query);
    order = sort ? sortRowIndexes(table.rows, sort.column, sort.direction, filtered) : filtered;
    rendered = 0;
    ragged = new Set(table.ragged);
    const wrap = el("div", "table-wrap");
    const grid = el("table", "grid");
    const thead = el("thead");
    const head = el("tr");
    const corner = el("th", "rn", "#");
    corner.scope = "col";
    head.append(corner);
    table.columns.forEach((name, column) => {
      const th = el("th");
      th.scope = "col";
      const current = sort?.column === column ? sort.direction : null;
      th.setAttribute("aria-sort", current === "asc" ? "ascending" : current === "desc" ? "descending" : "none");
      const b = button(name, "sort", `Sort by ${name}`);
      b.append(el("span", "arrow", current === "asc" ? " ▲" : current === "desc" ? " ▼" : ""));
      b.addEventListener("click", () => {
        sort = current === null ? { column, direction: "asc" } : current === "asc" ? { column, direction: "desc" } : null;
        render();
      });
      th.append(b);
      head.append(th);
    });
    thead.append(head);
    tbody = el("tbody");
    grid.append(thead, tbody);
    wrap.append(grid);
    view.append(wrap);
    renderMore();
    if (query && !order.length) view.append(el("p", "empty", "No row matches the filter."));
  };

  headerBtn.addEventListener("click", () => {
    table = csvTable(text, { delimiter: table.delimiter, header: !table.hasHeader });
    sort = null;
    describe();
    render();
  });
  describe();

  return {
    render,
    filter(q) {
      query = q.trim();
      render();
      return query ? order.length : null;
    },
    countLabel: (count) => `${fmt(count)} of ${fmt(table.rows.length)} rows`,
    controls: [headerBtn, size],
    table: () => table,
  };
}
