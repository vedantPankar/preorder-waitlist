/* eslint-disable react/prop-types -- small presentational components shared by the admin pages */
import uiCss from "./ui.css?url";

export const uiLinks = () => [{ rel: "stylesheet", href: uiCss }];

const PATHS = {
  home: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  chart: "M4 20V10M10 20V4M16 20v-8M22 20H2",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  box: "M21 8l-9-5-9 5v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8",
  tag: "M3 12V4h8l10 10-8 8L3 12zM7.5 8.5h.01",
  gear: "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 00-2.1-1.2L14 3h-4l-.5 2.7a7 7 0 00-2.1 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 002.1 1.2L10 21h4l.5-2.7a7 7 0 002.1-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z",
  mail: "M3 6h18v12H3V6zM3 7l9 6 9-6",
  users: "M16 20v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2M9.5 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 20v-2a4 4 0 00-3-3.9M16 3.1a3.5 3.5 0 010 6.8",
  cart: "M3 4h2l2.4 11h11l2-8H6M9 20h.01M17 20h.01",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
  megaphone: "M3 11v2a1 1 0 001 1h3l8 4V6L7 10H4a1 1 0 00-1 1zM19 9a4 4 0 010 6",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
  doc: "M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h12a1 1 0 001-1V8l-5-5zM14 3v5h5M9 13h6M9 17h6",
  undo: "M3 7v6h6M3 13a9 9 0 109-9 9 9 0 00-7 3.5",
  check: "M5 12l5 5L20 7",
  calendar: "M4 6h16v14H4V6zM4 10h16M8 3v4M16 3v4",
  monitor: "M3 4h18v12H3V4zM8 20h8M12 16v4",
  book: "M4 4h6a3 3 0 013 3v13a2 2 0 00-2-2H4V4zM20 4h-6a3 3 0 00-3 3v13a2 2 0 012-2h7V4z",
  chat: "M4 5h16v11H9l-5 4V5z",
  pause: "M10 6v12M14 6v12M12 21a9 9 0 100-18 9 9 0 000 18z",
  circleCheck: "M12 21a9 9 0 100-18 9 9 0 000 18zM8 12l3 3 5-6",
  chevron: "M9 6l6 6-6 6",
};

export function Icon({ name, className = "", size = "" }) {
  return (
    <span className={`wp-icon ${size} ${className}`.trim()} aria-hidden="true">
      <Svg name={name} />
    </span>
  );
}

export function Svg({ name }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <path d={PATHS[name] || PATHS.box} />
    </svg>
  );
}

export function Shell({ children }) {
  return <div className="wp-app">{children}</div>;
}

export function PageHead({ title, subtitle, children }) {
  return (
    <div className="wp-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="wp-head-actions">{children}</div>}
    </div>
  );
}

export function Card({ title, sub, action, flush, children, className = "" }) {
  return (
    <section className={`wp-card ${flush ? "flush" : ""} ${className}`.trim()}>
      {(title || action) && (
        <div className="wp-card-head">
          <div>
            {title && <h2>{title}</h2>}
            {sub && <div className="wp-card-sub">{sub}</div>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ icon, tone = "", label, value, note, delta, href, linkText }) {
  return (
    <div className="wp-stat">
      <Icon name={icon} className={tone} />
      <div>
        <div className="wp-stat-label">{label}</div>
        <div className="wp-stat-value">{value}</div>
        {delta}
        {note && <div className="wp-stat-note">{note}</div>}
        {href && <a className="wp-link" href={href}>{linkText} →</a>}
      </div>
    </div>
  );
}

export function Delta({ summary, label = "vs previous period" }) {
  if (!summary?.hasComparison) return <div className="wp-stat-note">No earlier data to compare</div>;
  const up = summary.growthPct >= 0;
  return (
    <div className="wp-delta" style={up ? undefined : { color: "var(--red)" }}>
      {up ? "↑" : "↓"} {up ? "+" : ""}{summary.growthPct}% <span className="wp-stat-note">{label}</span>
    </div>
  );
}

export function Badge({ tone = "", children }) {
  return <span className={`wp-badge ${tone}`.trim()}>{children}</span>;
}

export function Banner({ tone = "info", title, children, action }) {
  return (
    <div className={`wp-banner ${tone}`} role={tone === "critical" ? "alert" : "status"}>
      <div>
        {title && <strong>{title}</strong>}
        {children}
      </div>
      {action}
    </div>
  );
}

export function Button({ href, primary, danger, block, children, ...rest }) {
  const cls = `wp-btn ${primary ? "primary" : ""} ${danger ? "danger" : ""} ${block ? "block" : ""}`.replace(/\s+/g, " ").trim();
  return href ? <a className={cls} href={href} {...rest}>{children}</a> : <button type="button" className={cls} {...rest}>{children}</button>;
}

export function Field({ label, grow, children }) {
  return (
    <label className={`wp-field ${grow ? "grow" : ""}`.trim()}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="wp-toggle" onClick={onChange} />;
}

export function Thumb({ icon = "box" }) {
  return <span className="wp-thumb" aria-hidden="true"><Svg name={icon} /></span>;
}

export function Pager({ page, total, size, onPage, noun = "items" }) {
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(total, page * size);
  const shown = [];
  for (let n = Math.max(1, page - 2); n <= Math.min(pages, page + 2); n++) shown.push(n);
  return (
    <div className="wp-pager">
      <span>Showing {from}–{to} of {total} {noun}</span>
      {pages > 1 && (
        <nav className="wp-pages" aria-label="Pagination">
          <button type="button" className="wp-page-btn" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">‹</button>
          {shown.map((n) => <button key={n} type="button" className="wp-page-btn" aria-current={n === page ? "page" : undefined} onClick={() => onPage(n)}>{n}</button>)}
          <button type="button" className="wp-page-btn" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">›</button>
        </nav>
      )}
    </div>
  );
}

/** Accessible inline-SVG bar chart of per-day counts, with y-axis ticks and date labels. */
export function BarChart({ days, label }) {
  const max = Math.max(1, ...days.map((x) => x.count));
  const top = Math.max(2, max);
  const w = 600, h = 170, padL = 26, padB = 22, plotH = h - padB - 6, plotW = w - padL;
  const bar = plotW / Math.max(1, days.length);
  const total = days.reduce((a, x) => a + x.count, 0);
  const ticks = [0, Math.round(top / 2), top];
  const every = Math.max(1, Math.ceil(days.length / 6));
  const fmt = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <svg className="wp-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label ?? `${total} new signups over ${days.length} days`}>
      {ticks.map((t) => {
        const y = 6 + plotH - (t / top) * plotH;
        return (
          <g key={t}>
            <line x1={padL} x2={w} y1={y} y2={y} stroke="#e3e5e7" />
            <text x={padL - 6} y={y + 4} fontSize="10" textAnchor="end" fill="#5c6166">{t}</text>
          </g>
        );
      })}
      {days.map((x, i) => {
        const bh = (x.count / top) * plotH;
        return (
          <g key={x.date}>
            <rect x={padL + i * bar + 1} y={6 + plotH - bh} width={Math.max(1, bar - 2)} height={bh} rx="2" fill="#006f5c"><title>{`${x.date}: ${x.count}`}</title></rect>
            {i % every === 0 && <text x={padL + i * bar + bar / 2} y={h - 6} fontSize="10" textAnchor="middle" fill="#5c6166">{fmt(x.date)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export const entryTone = { ACTIVE: "info", SENDING: "info", NOTIFIED: "success", FAILED: "critical", REMOVED: "" };
export const entryLabel = (s) => (s === "ACTIVE" ? "Waiting" : s.charAt(0) + s.slice(1).toLowerCase());
export const variantName = (title, variant) => `${title}${variant && variant !== "Default Title" ? ` — ${variant}` : ""}`;
export const shortDate = (d) => new Date(d).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });

export function SectionTitle({ icon, tone = "", title, sub }) {
  return (
    <div className="wp-section-title">
      <Icon name={icon} className={tone} />
      <div><h2>{title}</h2><p>{sub}</p></div>
    </div>
  );
}

/** Settings row: bold label and help text on the left, the control on the right. */
export function SettingRow({ title, help, children }) {
  return (
    <div className="wp-row">
      <div><strong>{title}</strong>{help && <span className="wp-muted">{help}</span>}</div>
      <div>{children}</div>
    </div>
  );
}
