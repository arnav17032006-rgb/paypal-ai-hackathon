// Small inline icon set (simple stroke paths drawn for this project), shared by the app and the login page.
const ICON_PATHS = {
  shield: '<path d="M12 3l8 3v6c0 4.6-3.2 8-8 9-4.800-1-8-4.400-8-9V6z"/><path d="M8.500 12l2.500 2.500 4.500-5"/>',
  sparkles: '<path d="M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800z"/><path d="M19 15v4M17 17h4M5 3v3M3.500 4.500h3"/>',
  store: '<path d="M4 9l1.500-5h13L20 9"/><path d="M4 9v1a2.700 2.700 0 005.300 0 2.700 2.700 0 005.400 0A2.700 2.700 0 0020 10V9z"/><path d="M5.500 12.500V20h13v-7.500M10 20v-4h4v4"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-3"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  moon: '<path d="M20 14.500A8 8 0 019.500 4 8 8 0 1020 14.500z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.400 1.400M17.600 17.600L19 19M5 19l1.400-1.400M17.600 6.400L19 5"/>',
  logout: '<path d="M10 4H5v16h5"/><path d="M15 8l4 4-4 4M19 12H9"/>',
  search: '<circle cx="11" cy="11" r="6.500"/><path d="M16 16l4.500 4.500"/>',
  check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.200v.1"/>',
  hand: '<circle cx="12" cy="12" r="9"/><path d="M12 7.500V12l3 2"/>',
  cart: '<path d="M3 4h2.500l2.200 11h10l2-8H7"/><circle cx="9.500" cy="19" r="1.400"/><circle cx="16.500" cy="19" r="1.400"/>',
  bot: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 8V4.500M9.500 13v1.500M14.500 13v1.500"/><circle cx="12" cy="3.500" r="1"/>',
  wallet: '<path d="M4 7.500A2.500 2.500 0 016.500 5H18v3"/><rect x="4" y="8" width="16" height="11" rx="2.500"/><path d="M16 13.500h.1"/>',
  lock: '<rect x="5" y="10.500" width="14" height="9.500" rx="2.500"/><path d="M8 10.500V8a4 4 0 018 0v2.500"/>',
  truck: '<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7.500" cy="17.500" r="1.800"/><circle cx="17" cy="17.500" r="1.800"/>',
  undo: '<path d="M8 8H4V4"/><path d="M4 8a8 8 0 111.500 8.500"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.500 20a7.500 7.500 0 0115 0"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.700 5.700l12.600 12.600"/>',
  plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 01-10 0zM12 16v5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  pin: '<path d="M12 21s7-6.200 7-11.500A7 7 0 005 9.500C5 14.800 12 21 12 21z"/><circle cx="12" cy="9.500" r="2.500"/>',
};

function icon(name) {
  return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
}

function paintIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
    el.style.display = "inline-grid";
  });
}
paintIcons();
