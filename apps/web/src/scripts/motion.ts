// Movimiento del sitio: aparición al hacer scroll, contadores y sección activa en la navegación.
const root = document.documentElement;
root.classList.add("motion-live"); // avisa al respaldo del <head> que el script cargó

const motionEnabled = root.classList.contains("motion");

const REVEAL = [
  ".section-head", ".tabs", ".code-window", ".section__inner > .links",
  ".table-box", ".stats", ".note", ".deploys__row",
  ".showcase__copy", ".receipt", ".cta__copy", ".cta__actions",
].join(", ");
const TRIGGER = ".hairline-grid, .split";

function countUp(el: HTMLElement) {
  const final = el.textContent ?? "";
  const match = final.match(/^(\D*)([\d.]+)(.*)$/);
  if (!match) return;
  const [, prefix, num, suffix] = match;
  const target = parseFloat(num);
  const decimals = (num.split(".")[1] ?? "").length;
  const duration = 900;
  const start = performance.now();
  el.setAttribute("aria-label", final);

  const tick = (now: number) => {
    const p = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = `${prefix}${(target * eased).toFixed(decimals)}${suffix}`;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

if (motionEnabled) {
  // Orden de entrada dentro de cada rejilla: celda (--c) y elemento dentro de la celda (--k)
  document.querySelectorAll<HTMLElement>(".hairline-grid").forEach((grid) => {
    Array.from(grid.children).forEach((cell, c) => {
      Array.from(cell.children).forEach((child, k) => {
        (child as HTMLElement).style.setProperty("--c", String(c));
        (child as HTMLElement).style.setProperty("--k", String(k));
      });
    });
  });

  const reveal = new IntersectionObserver(
    (entries) => {
      // Lo que entra a la vez aparece escalonado, de arriba hacia abajo
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

      visible.forEach((entry, i) => {
        const el = entry.target as HTMLElement;
        el.style.setProperty("--d", `${i * 90}ms`);
        el.classList.add("is-in");
        if (el.classList.contains("stats")) {
          el.querySelectorAll<HTMLElement>(".stat__value").forEach(countUp);
        }
        reveal.unobserve(el);
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
  );

  document.querySelectorAll(`${REVEAL}, ${TRIGGER}`).forEach((el) => reveal.observe(el));
}

// Sección activa en la navegación (también con movimiento reducido)
const navLinks = new Map<string, HTMLAnchorElement>();
document.querySelectorAll<HTMLAnchorElement>('.nav__links a[href^="#"]').forEach((a) => {
  navLinks.set(a.getAttribute("href")!.slice(1), a);
});

const spy = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const current = navLinks.get(entry.target.id);
      navLinks.forEach((a) => {
        if (a === current) a.setAttribute("aria-current", "true");
        else a.removeAttribute("aria-current");
      });
    }
  },
  { rootMargin: "-45% 0px -50% 0px" },
);
document.querySelectorAll("main section[id]").forEach((s) => spy.observe(s));