// Print page of the Overview report: renders the report Overview left in session storage and opens Chrome's
// print dialog, where "Save as PDF" makes the file. Everything stays in the browser.
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { browser } from "wxt/browser";
import { PRINT_REPORT_KEY, type PrintReport } from "../lib/report";

export function PrintApp() {
  const [report, setReport] = useState<PrintReport | null | undefined>();
  useEffect(() => {
    browser.storage.session.get(PRINT_REPORT_KEY).then(
      (r) => setReport((r[PRINT_REPORT_KEY] as PrintReport | undefined) ?? null),
      () => setReport(null),
    );
  }, []);
  useEffect(() => {
    if (!report) return;
    document.title = `devkit report · ${report.title}`;
    // Let the layout settle before the dialog takes a snapshot of the page.
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, [report]);
  if (report === undefined) return null;
  if (!report)
    return (
      <main className="print-page">
        <p>No report to print. Open devkit's Overview and use Print / Save as PDF.</p>
      </main>
    );
  return (
    <main className="print-page">
      <div className="print-actions">
        <button type="button" className="btn primary" onClick={() => window.print()}>
          Print / Save as PDF
        </button>
      </div>
      <article className="markdown print-report">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{ a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
        >
          {report.markdown}
        </ReactMarkdown>
      </article>
    </main>
  );
}
