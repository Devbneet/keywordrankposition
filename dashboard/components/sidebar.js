/**
 * Collapsible dark-navy SaaS sidebar navigation controller with keyboard accessibility.
 */

export function initSidebarNavigation({
  sidebarEl,
  toggleBtn,
  navButtons,
  pages,
  onNavigate,
}) {
  let activePage = "overview";

  function navigateTo(pageId) {
    if (!pageId || pageId === "scheduled-checks") return;
    activePage = pageId;

    pages.forEach((p) => {
      p.classList.toggle("hidden", p.dataset.page !== pageId);
    });
    navButtons.forEach((btn) => {
      const isCurrent = btn.dataset.nav === pageId;
      btn.classList.toggle("active", isCurrent);
      btn.setAttribute("aria-current", isCurrent ? "page" : "false");
    });

    if (onNavigate) onNavigate(pageId);
  }

  navButtons.forEach((btn) => {
    if (btn.disabled || btn.dataset.nav === "scheduled-checks") return;
    btn.addEventListener("click", () => navigateTo(btn.dataset.nav));
  });

  if (toggleBtn && sidebarEl) {
    toggleBtn.addEventListener("click", () => {
      sidebarEl.classList.toggle("collapsed");
    });
  }

  navigateTo("overview");
  return {
    navigateTo,
    getActivePage: () => activePage,
  };
}

