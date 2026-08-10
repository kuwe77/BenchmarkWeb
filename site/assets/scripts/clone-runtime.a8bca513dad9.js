(() => {
  "use strict";

  if (document.documentElement.dataset.omgRuntime) return;
  document.documentElement.dataset.omgRuntime = "booting";

  const CONSENT_KEY = "omg-clone-cookie-consent";
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointerQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
  const reducedMotion = reducedMotionQuery.matches;
  const finePointer = finePointerQuery.matches;
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  const supportsWebAnimations = typeof Element !== "undefined" && typeof Element.prototype.animate === "function";

  const perf = {
    version: "2.0.0",
    ready: false,
    reducedMotion,
    finePointer,
    animationOwners: {
      smoothScroll: "native",
      scrollTimelines: gsap && ScrollTrigger ? "gsap-scrolltrigger" : "none",
      reveals: reducedMotion ? "static" : supportsWebAnimations ? "web-animations-intersection-observer" : gsap ? "gsap-intersection-observer" : "static",
      splitTitles: reducedMotion ? "static" : supportsWebAnimations ? "web-animations-plus-gsap-reversible" : gsap ? "gsap-intersection-observer" : "static",
      marquees: reducedMotion ? "static" : "css-compositor",
      counters: reducedMotion ? "static" : "shared-frame-scheduler",
      cursor: finePointer && !reducedMotion ? "shared-frame-scheduler" : "disabled",
      cursorNoise: finePointer && !reducedMotion ? "shared-frame-scheduler" : "disabled",
    },
    triggers: [],
  };
  window.__OMG_PERF__ = perf;

  window.dataLayer = [];
  window.gtag = () => {};

  const queryAll = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const parseSeconds = (value, fallback = 0) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const POWER2_OUT = "cubic-bezier(.215,.61,.355,1)";
  const POWER3_OUT = "cubic-bezier(.165,.84,.44,1)";
  const centerStaggerDelay = (index, count, each) => {
    if (count < 2 || each <= 0) return 0;
    const center = (count - 1) / 2;
    const minimumDistance = count % 2 === 0 ? 0.5 : 0;
    const maximumDistance = center;
    const distanceRange = maximumDistance - minimumDistance;
    if (distanceRange <= 0) return 0;
    return ((Math.abs(index - center) - minimumDistance) / distanceRange) * each * (count - 1);
  };
  const animateStaggered = (targets, keyframes, {
    delay = 0,
    duration,
    easing,
    fromCenter = false,
    stagger = 0,
  }) => {
    const elements = Array.from(targets);
    if (!supportsWebAnimations) return [];
    return elements.map((element, index) => {
      const itemDelay = fromCenter
        ? centerStaggerDelay(index, elements.length, stagger)
        : index * stagger;
      return element.animate(keyframes, {
        delay: Math.max(0, delay + itemDelay) * 1000,
        duration: Math.max(0, duration) * 1000,
        easing,
        // Only the starting state needs filling during a stagger delay. Once
        // finished, the element's existing final styles take over and Chrome
        // can immediately release the compositor animation.
        fill: "backwards",
      });
    });
  };
  const safeStorage = {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // The clone must remain functional when storage is unavailable.
      }
    },
  };
  const targetFromControl = (control) => {
    const selector = control.getAttribute("data-bs-target");
    if (!selector || !/^#[A-Za-z][\w:.-]*$/.test(selector)) return null;
    return document.getElementById(selector.slice(1));
  };
  const addTriggerDiagnostic = (selector, owner) => {
    const count = document.querySelectorAll(selector).length;
    if (count) perf.triggers.push({ selector, count, owner });
  };

  const scheduler = (() => {
    const tasks = new Set();
    let attached = false;
    let rafId = 0;

    const runTasks = (timeMs) => {
      for (const task of Array.from(tasks)) task(timeMs);
    };
    const gsapTick = () => runTasks(performance.now());
    const rafTick = (timeMs) => {
      runTasks(timeMs);
      if (tasks.size) rafId = window.requestAnimationFrame(rafTick);
      else attached = false;
    };
    const attach = () => {
      if (attached) return;
      attached = true;
      if (gsap?.ticker) gsap.ticker.add(gsapTick);
      else rafId = window.requestAnimationFrame(rafTick);
    };
    const detach = () => {
      if (!attached || tasks.size) return;
      attached = false;
      if (gsap?.ticker) gsap.ticker.remove(gsapTick);
      else window.cancelAnimationFrame(rafId);
    };

    return {
      add(task) {
        tasks.add(task);
        attach();
        return () => {
          tasks.delete(task);
          detach();
        };
      },
      size: () => tasks.size,
    };
  })();

  let lenis = null;
  let refreshTimer = 0;
  const requestScrollRefresh = () => {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      lenis?.resize?.();
      ScrollTrigger?.refresh?.();
    }, 180);
  };

  const initSmoothScroll = () => {
    if (!reducedMotion && typeof window.Lenis === "function") {
      try {
        lenis = new window.Lenis({
          duration: 1,
          easing: (t) => 1 - Math.pow(1 - t, 4),
          orientation: "vertical",
          gestureOrientation: "vertical",
          smoothWheel: true,
          syncTouch: false,
          autoRaf: false,
        });
        scheduler.add((timeMs) => lenis.raf(timeMs));
        lenis.on?.("scroll", () => ScrollTrigger?.update?.());
        perf.animationOwners.smoothScroll = gsap?.ticker ? "lenis-gsap-ticker" : "lenis-raf";
      } catch {
        lenis = null;
      }
    }

    document.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
      if (!(link instanceof HTMLAnchorElement)) return;
      const hash = link.getAttribute("href");
      if (!hash || hash === "#") return;
      let target;
      try {
        target = document.querySelector(hash);
      } catch {
        return;
      }
      if (!(target instanceof Element)) return;

      event.preventDefault();
      closeOffcanvas();
      if (lenis) {
        lenis.scrollTo(target, {
          duration: 1.2,
          easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        });
      } else {
        target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
      }
    });
  };

  let previousFocus = null;
  const offcanvas = () => document.querySelector(".offcanvas_box_active");
  const overlay = () => document.querySelector(".wa-overly");
  const closeOffcanvas = ({ restoreFocus = true } = {}) => {
    const panel = offcanvas();
    const backdrop = overlay();
    panel?.classList.remove("active");
    backdrop?.classList.remove("active");
    panel?.setAttribute("aria-hidden", "true");
    document.querySelector(".offcanvas_toggle")?.setAttribute("aria-expanded", "false");
    document.documentElement.classList.remove("omg-scroll-locked");
    if (restoreFocus && previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  };
  const openOffcanvas = (toggle) => {
    const panel = offcanvas();
    const backdrop = overlay();
    if (!panel || !backdrop) return;
    previousFocus = document.activeElement;
    panel.classList.add("active");
    backdrop.classList.add("active");
    panel.setAttribute("aria-hidden", "false");
    toggle?.setAttribute("aria-expanded", "true");
    document.documentElement.classList.add("omg-scroll-locked");
    window.setTimeout(() => panel.querySelector(".offcanvas_box_close, a")?.focus({ preventScroll: true }), 30);
  };
  const initNavigation = () => {
    const panel = offcanvas();
    const toggle = document.querySelector(".offcanvas_toggle");
    panel?.setAttribute("aria-hidden", panel.classList.contains("active") ? "false" : "true");
    if (panel?.id === "") panel.id = "omg-mobile-menu";
    if (toggle) {
      toggle.setAttribute("aria-controls", panel?.id || "omg-mobile-menu");
      toggle.setAttribute("aria-expanded", "false");
    }

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const mobileToggle = target.closest(".offcanvas_toggle");
      if (mobileToggle) {
        event.preventDefault();
        openOffcanvas(mobileToggle);
        return;
      }
      if (target.closest(".offcanvas_box_close, .wa-overly")) {
        event.preventDefault();
        closeOffcanvas();
        return;
      }
      if (target.closest(".offcanvas_box_active a")) closeOffcanvas({ restoreFocus: false });

      const menuToggle = target.closest(".as-header-1-menu-toggle-btn");
      if (menuToggle) {
        const menu = document.querySelector(".as-header-1-menu");
        const open = !menuToggle.classList.contains("active");
        menuToggle.classList.toggle("active", open);
        menu?.classList.toggle("show", open);
        menuToggle.setAttribute("aria-expanded", String(open));
      }
    });

    const desktopToggle = document.querySelector(".as-header-1-menu-toggle-btn");
    if (desktopToggle) {
      desktopToggle.setAttribute("role", "button");
      desktopToggle.setAttribute("tabindex", "0");
      desktopToggle.setAttribute("aria-expanded", String(desktopToggle.classList.contains("active")));
      desktopToggle.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          desktopToggle.click();
        }
      });
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeOffcanvas();
    });

    const backToTop = document.querySelector(".wa_backToTop");
    if (backToTop) {
      backToTop.setAttribute("role", "button");
      backToTop.setAttribute("tabindex", "0");
      const goTop = (event) => {
        event.preventDefault();
        if (lenis) lenis.scrollTo(0, { duration: 1 });
        else window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
      };
      backToTop.addEventListener("click", goTop);
      backToTop.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") goTop(event);
      });

      let scrollQueued = false;
      const updateBackToTop = () => {
        backToTop.classList.toggle("active", window.scrollY > 500);
        scrollQueued = false;
      };
      window.addEventListener("scroll", () => {
        if (!scrollQueued) {
          scrollQueued = true;
          window.requestAnimationFrame(updateBackToTop);
        }
      }, { passive: true });
      updateBackToTop();
    }
  };

  const setTab = (button, focus = false) => {
    const tabList = button.closest('[role="tablist"]');
    const target = targetFromControl(button);
    if (!tabList || !target) return;
    const buttons = queryAll('[data-bs-toggle="tab"]', tabList);
    const content = target.closest(".tab-content");

    for (const peer of buttons) {
      const active = peer === button;
      peer.classList.toggle("active", active);
      peer.setAttribute("aria-selected", String(active));
      peer.setAttribute("tabindex", active ? "0" : "-1");
    }
    for (const pane of queryAll(":scope > .tab-pane", content || document)) {
      const active = pane === target;
      pane.classList.toggle("active", active);
      pane.classList.toggle("show", active);
      pane.hidden = !active;
    }
    if (focus) button.focus();
    requestScrollRefresh();
  };
  const initTabs = () => {
    for (const tabList of queryAll('[role="tablist"]')) {
      const buttons = queryAll('[data-bs-toggle="tab"]', tabList);
      const active = buttons.find((button) => button.classList.contains("active")) || buttons[0];
      if (active) setTab(active);
    }

    document.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-bs-toggle="tab"]') : null;
      if (!button) return;
      event.preventDefault();
      setTab(button);
    });
    document.addEventListener("keydown", (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-bs-toggle="tab"]') : null;
      const tabList = button?.closest('[role="tablist"]');
      if (!button || !tabList || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const buttons = queryAll('[data-bs-toggle="tab"]', tabList);
      let index = buttons.indexOf(button);
      if (event.key === "Home") index = 0;
      else if (event.key === "End") index = buttons.length - 1;
      else index = (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault();
      setTab(buttons[index], true);
    });
  };

  const setCollapse = (button, panel, open, animate = true) => {
    const item = button.closest(".wa_accordion_item");
    panel._omgCollapseAnimation?.cancel?.();
    button.classList.toggle("collapsed", !open);
    button.setAttribute("aria-expanded", String(open));
    item?.classList.toggle("active", open);

    if (!animate || reducedMotion || typeof panel.animate !== "function") {
      panel.hidden = !open;
      panel.classList.toggle("show", open);
      return;
    }

    panel.classList.add("omg-collapsing");
    if (open) {
      panel.hidden = false;
      panel.classList.add("show");
      const height = panel.scrollHeight;
      panel._omgCollapseAnimation = panel.animate(
        [{ height: "0px", opacity: 0 }, { height: `${height}px`, opacity: 1 }],
        { duration: 350, easing: "cubic-bezier(.25,.8,.25,1)" }
      );
    } else {
      const height = panel.getBoundingClientRect().height;
      panel._omgCollapseAnimation = panel.animate(
        [{ height: `${height}px`, opacity: 1 }, { height: "0px", opacity: 0 }],
        { duration: 300, easing: "cubic-bezier(.4,0,.2,1)" }
      );
    }

    panel._omgCollapseAnimation.finished.then(() => {
      panel.classList.remove("omg-collapsing");
      panel.classList.toggle("show", open);
      panel.hidden = !open;
      panel._omgCollapseAnimation = null;
      requestScrollRefresh();
    }).catch(() => {});
  };
  const initAccordions = () => {
    for (const button of queryAll('[data-bs-toggle="collapse"]')) {
      const panel = targetFromControl(button);
      if (!panel) continue;
      const open = panel.classList.contains("show");
      setCollapse(button, panel, open, false);
    }

    document.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-bs-toggle="collapse"]') : null;
      if (!button) return;
      const panel = targetFromControl(button);
      if (!panel) return;
      event.preventDefault();
      const shouldOpen = button.classList.contains("collapsed");
      const accordion = button.closest(".as-accordion");
      if (shouldOpen && accordion) {
        for (const peer of queryAll('[data-bs-toggle="collapse"]', accordion)) {
          if (peer === button) continue;
          const peerPanel = targetFromControl(peer);
          if (peerPanel && peer.getAttribute("aria-expanded") === "true") setCollapse(peer, peerPanel, false);
        }
      }
      setCollapse(button, panel, shouldOpen);
    });
  };

  const getConsent = () => {
    const raw = safeStorage.get(CONSENT_KEY);
    if (!raw) return null;
    if (raw === "accepted") return { accept: true };
    if (raw === "rejected") return { reject: true };
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const saveConsent = (value) => safeStorage.set(CONSENT_KEY, JSON.stringify(value));
  const initConsent = () => {
    const notice = document.querySelector(".cookieadmin_law_container");
    const modal = document.querySelector(".cookieadmin_cookie_modal");
    const reconsent = document.querySelector(".cookieadmin_re_consent");
    if (!notice || !modal) return;

    let embeddedPolicy = {};
    try {
      embeddedPolicy = JSON.parse(document.getElementById("clone-cookie-policy")?.textContent || "{}");
    } catch {
      embeddedPolicy = {};
    }
    const policy = window.cookieadmin_policy || {};
    const strings = {
      title: embeddedPolicy.noticeTitle || policy.cookieadmin_notice_title || "We respect your privacy",
      notice: embeddedPolicy.notice || policy.cookieadmin_notice || "Cookies help us improve your experience. You can accept, reject, or customize optional cookies.",
      preferenceTitle: embeddedPolicy.preferenceTitle || policy.cookieadmin_preference_title || "Personalize Your Cookie Preferences",
      preference: embeddedPolicy.preference || policy.cookieadmin_preference || "Choose which optional cookies this local clone may remember on this device.",
    };
    const title = document.getElementById("cookieadmin_notice_title");
    const noticeText = document.getElementById("cookieadmin_notice");
    const preferenceTitle = document.getElementById("cookieadmin_preference_title");
    const preferenceText = document.getElementById("cookieadmin_preference");
    if (title && !title.textContent.trim()) title.textContent = strings.title;
    if (noticeText && !noticeText.textContent.trim()) noticeText.innerHTML = strings.notice;
    if (preferenceTitle && !preferenceTitle.textContent.trim()) preferenceTitle.textContent = strings.preferenceTitle;
    if (preferenceText && !preferenceText.textContent.trim()) preferenceText.innerHTML = strings.preference;

    const layout = embeddedPolicy.layout || "box";
    const position = embeddedPolicy.position || "bottom_left";
    const modalPosition = embeddedPolicy.modal || "center";
    notice.classList.add(`cookieadmin_${layout}`);
    for (const value of position.split("_").filter(Boolean)) notice.classList.add(`cookieadmin_${value}`);
    modal.classList.add(`cookieadmin_${modalPosition}`);
    modal.setAttribute("aria-hidden", "true");
    let modalOverlay = document.querySelector(".cookieadmin_modal_overlay");
    if (!modalOverlay) {
      modalOverlay = document.createElement("div");
      modalOverlay.className = "cookieadmin_modal_overlay";
      document.body.appendChild(modalOverlay);
    }

    const applyConsentVisibility = () => {
      const hasConsent = Boolean(getConsent());
      if (hasConsent) {
        notice.classList.remove("omg-cookie-pending");
        notice.style.display = "none";
      } else if (!notice.classList.contains("omg-cookie-pending") || notice.style.display === "none") {
        notice.style.display = "block";
      }
      if (reconsent) reconsent.style.display = hasConsent ? "block" : "none";
    };
    const populateChecks = () => {
      const consent = getConsent();
      for (const input of queryAll(".cookieadmin_toggle input[type='checkbox']")) {
        const category = input.id.replace("cookieadmin-", "");
        input.checked = Boolean(consent?.accept || consent?.[category]);
      }
    };
    const closeModal = () => {
      modal.style.display = "none";
      modal.setAttribute("aria-hidden", "true");
      modalOverlay.style.display = "none";
      applyConsentVisibility();
    };
    const openModal = () => {
      populateChecks();
      notice.style.display = "none";
      if (reconsent) reconsent.style.display = "none";
      modal.style.display = "flex";
      modal.setAttribute("aria-hidden", "false");
      modalOverlay.style.display = "block";
      modal.querySelector(".cookieadmin_close_pref")?.focus({ preventScroll: true });
    };
    const finish = (value) => {
      saveConsent(value);
      closeModal();
    };

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("#cookieadmin_customize_button, .cookieadmin_re_consent")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openModal();
        return;
      }
      if (target.closest(".cookieadmin_close_pref, .cookieadmin_modal_overlay")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeModal();
        return;
      }
      const decision = target.closest("#cookieadmin_accept_button, #cookieadmin_accept_modal_button, #cookieadmin_reject_button, #cookieadmin_reject_modal_button");
      if (decision) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(decision.classList.contains("cookieadmin_reject_btn") ? { reject: true } : { accept: true });
        return;
      }
      if (target.closest("#cookieadmin_prf_modal_button")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const selected = {};
        for (const input of queryAll(".cookieadmin_toggle input[type='checkbox']:checked")) {
          selected[input.id.replace("cookieadmin-", "")] = true;
        }
        finish(Object.keys(selected).length ? selected : { reject: true });
        return;
      }
      const showMore = target.closest(".cookieadmin_showmore");
      if (showMore && preferenceText) {
        const expanded = showMore.getAttribute("aria-expanded") === "true";
        showMore.setAttribute("aria-expanded", String(!expanded));
        showMore.textContent = expanded ? "show more" : "show less";
        preferenceText.style.height = expanded ? "" : "auto";
        return;
      }
      const detailToggle = target.closest(".cookieadmin_show_pref_cookies");
      if (detailToggle) {
        const detailClass = detailToggle.id.replace(/-container$/, "");
        const details = document.querySelector(`.${detailClass}`);
        const open = !detailToggle.classList.contains("dwn");
        detailToggle.classList.toggle("dwn", open);
        detailToggle.textContent = open ? "▼" : "►";
        if (details) details.style.display = open ? "block" : "none";
      }
    }, true);

    applyConsentVisibility();
  };

  const showFormResult = (form, message, status) => {
    const output = form.closest(".wpcf7")?.querySelector(".wpcf7-response-output");
    if (!(output instanceof HTMLElement)) return;
    output.textContent = message;
    output.style.display = "block";
    output.hidden = false;
    output.setAttribute("aria-hidden", "false");
    output.setAttribute("role", status === "sent" ? "status" : "alert");
    form.dataset.status = status;
  };
  const validateLocalForm = (form) => {
    let firstInvalid = null;
    for (const field of queryAll("[aria-required='true']", form)) {
      const empty = "value" in field && !String(field.value).trim();
      const typeMismatch = field instanceof HTMLInputElement && field.type === "email" && field.value && !field.validity.valid;
      const invalid = empty || typeMismatch;
      field.classList.toggle("wpcf7-not-valid", invalid);
      field.setAttribute("aria-invalid", String(invalid));
      if (invalid && !firstInvalid) firstInvalid = field;
    }
    firstInvalid?.focus({ preventScroll: false });
    return !firstInvalid;
  };
  const initLocalForms = () => {
    document.addEventListener("submit", (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.classList.contains("wpcf7-form")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!validateLocalForm(form)) {
        showFormResult(form, "Please complete the required fields before submitting.", "invalid");
        return;
      }
      showFormResult(form, "Thanks. This local clone keeps submissions on your device.", "sent");
    }, true);
    document.addEventListener("input", (event) => {
      const field = event.target;
      if (!(field instanceof HTMLElement) || !field.closest(".wpcf7-form")) return;
      field.classList.remove("wpcf7-not-valid");
      field.setAttribute("aria-invalid", "false");
    });
  };

  const initNiceSelects = () => {
    const widgets = [];
    const closeAll = (except = null) => {
      for (const widget of widgets) {
        if (widget === except) continue;
        widget.classList.remove("open");
        widget.setAttribute("aria-expanded", "false");
        widget.querySelector(".option.focus")?.classList.remove("focus");
      }
    };
    const syncWidget = (select, widget) => {
      const options = queryAll(".option", widget);
      const selectedIndex = Math.max(0, select.selectedIndex);
      const nativeOption = select.options[selectedIndex];
      const current = widget.querySelector(".current");
      if (current) current.textContent = nativeOption?.dataset.display || nativeOption?.textContent || "";
      options.forEach((option, index) => {
        const selected = index === selectedIndex;
        option.classList.toggle("selected", selected);
        option.setAttribute("aria-selected", String(selected));
      });
    };
    const setFocusOption = (widget, direction) => {
      const enabled = queryAll(".option:not(.disabled)", widget);
      if (!enabled.length) return;
      const focused = widget.querySelector(".option.focus");
      let index = focused ? enabled.indexOf(focused) : enabled.findIndex((option) => option.classList.contains("selected"));
      if (direction === "first") index = 0;
      else if (direction === "last") index = enabled.length - 1;
      else index = Math.max(0, Math.min(enabled.length - 1, index + direction));
      focused?.classList.remove("focus");
      enabled[index]?.classList.add("focus");
      enabled[index]?.scrollIntoView({ block: "nearest" });
    };
    const openWidget = (widget) => {
      closeAll(widget);
      widget.classList.add("open");
      widget.setAttribute("aria-expanded", "true");
      widget.querySelector(".option.focus")?.classList.remove("focus");
      widget.querySelector(".option.selected:not(.disabled)")?.classList.add("focus");
    };
    const closeWidget = (widget) => {
      widget.classList.remove("open");
      widget.setAttribute("aria-expanded", "false");
      widget.querySelector(".option.focus")?.classList.remove("focus");
    };
    const chooseOption = (widget, option) => {
      if (!option || option.classList.contains("disabled")) return;
      const select = widget.previousElementSibling;
      if (!(select instanceof HTMLSelectElement)) return;
      select.value = option.dataset.value || "";
      syncWidget(select, widget);
      closeWidget(widget);
      widget.focus({ preventScroll: true });
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };

    for (const select of queryAll(".as-cta-2-form-selector select")) {
      if (!(select instanceof HTMLSelectElement) || select.dataset.omgNiceSelect === "ready") continue;
      const existing = select.nextElementSibling;
      if (existing?.matches?.(".nice-select[data-omg-nice-select]")) {
        widgets.push(existing);
        continue;
      }

      const widget = document.createElement("div");
      widget.className = `nice-select ${select.className}`.trim();
      widget.dataset.omgNiceSelect = "true";
      widget.tabIndex = select.disabled ? -1 : 0;
      widget.setAttribute("role", "combobox");
      widget.setAttribute("aria-haspopup", "listbox");
      widget.setAttribute("aria-expanded", "false");
      widget.setAttribute("aria-label", select.getAttribute("aria-label") || select.options[0]?.textContent || "Choose an option");

      const current = document.createElement("span");
      current.className = "current";
      const list = document.createElement("ul");
      list.className = "list";
      list.setAttribute("role", "listbox");
      list.tabIndex = -1;
      for (const [index, nativeOption] of Array.from(select.options).entries()) {
        const option = document.createElement("li");
        option.className = `option${nativeOption.selected ? " selected" : ""}${nativeOption.disabled ? " disabled" : ""}`;
        option.dataset.value = nativeOption.value;
        if (nativeOption.dataset.display) option.dataset.display = nativeOption.dataset.display;
        option.textContent = nativeOption.textContent;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === select.selectedIndex));
        option.setAttribute("aria-disabled", String(nativeOption.disabled));
        list.appendChild(option);
      }
      widget.append(current, list);
      select.insertAdjacentElement("afterend", widget);
      select.classList.add("omg-native-select");
      select.dataset.omgNiceSelect = "ready";
      select.setAttribute("aria-hidden", "true");
      select.tabIndex = -1;
      syncWidget(select, widget);
      select.addEventListener("change", () => syncWidget(select, widget));
      widgets.push(widget);
    }

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const widget = target.closest(".nice-select[data-omg-nice-select]");
      if (!widget) {
        closeAll();
        return;
      }
      event.preventDefault();
      const option = target.closest(".option");
      if (option) chooseOption(widget, option);
      else if (widget.classList.contains("open")) closeWidget(widget);
      else openWidget(widget);
    });
    document.addEventListener("keydown", (event) => {
      const widget = event.target instanceof Element ? event.target.closest(".nice-select[data-omg-nice-select]") : null;
      if (!widget) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeWidget(widget);
        return;
      }
      if (event.key === "Tab") {
        closeWidget(widget);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        if (!widget.classList.contains("open")) openWidget(widget);
        if (event.key === "Home") setFocusOption(widget, "first");
        else if (event.key === "End") setFocusOption(widget, "last");
        else setFocusOption(widget, event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!widget.classList.contains("open")) openWidget(widget);
        else chooseOption(widget, widget.querySelector(".option.focus") || widget.querySelector(".option.selected"));
      }
    });
  };

  const cloneMarqueeContent = (track) => {
    if (track.dataset.omgMarquee === "ready") return;
    const content = track.firstElementChild;
    if (!content) return;
    const clone = content.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    clone.dataset.omgMarqueeClone = "true";
    track.appendChild(clone);
    track.dataset.omgMarquee = "ready";
  };
  const measureMarquees = () => {
    for (const track of queryAll(".wa_marquee_left_nopause, .wa_marquee_right_nopause")) {
      const content = track.firstElementChild;
      if (!content) continue;
      const seconds = Math.max(18, content.getBoundingClientRect().width / 20);
      track.style.setProperty("--omg-marquee-duration", `${seconds.toFixed(2)}s`);
    }
  };
  const initMarquees = () => {
    for (const track of queryAll(".wa_marquee_left_nopause, .wa_marquee_right_nopause")) cloneMarqueeContent(track);
    for (const track of queryAll(".wa_marquee_down_top")) {
      if (track.dataset.omgMarquee === "ready") continue;
      const clone = track.cloneNode(true);
      clone.setAttribute("aria-hidden", "true");
      clone.dataset.omgMarqueeClone = "true";
      track.parentNode?.appendChild(clone);
      track.dataset.omgMarquee = "ready";
    }
    measureMarquees();
    document.fonts?.ready?.then(measureMarquees);
  };

  const initCounters = () => {
    const counters = queryAll(".odometer[data-count]");
    const buildDigit = (initialValue, finalValue) => {
      const digit = document.createElement("span");
      digit.className = "odometer-digit";

      const spacer = document.createElement("span");
      spacer.className = "odometer-digit-spacer";
      spacer.textContent = "8";

      const inner = document.createElement("span");
      inner.className = "odometer-digit-inner";
      const ribbon = document.createElement("span");
      ribbon.className = "odometer-ribbon";
      const ribbonInner = document.createElement("span");
      ribbonInner.className = "odometer-ribbon-inner";

      const initial = document.createElement("span");
      initial.className = "odometer-value odometer-first-value";
      initial.textContent = initialValue || "\u00a0";
      const final = document.createElement("span");
      final.className = "odometer-value odometer-last-value";
      final.textContent = finalValue;

      ribbonInner.append(initial, final);
      ribbon.append(ribbonInner);
      inner.append(ribbon);
      digit.append(spacer, inner);
      return digit;
    };
    const prepare = (counter) => {
      const end = Number.parseFloat(counter.dataset.count || "0");
      if (!Number.isFinite(end)) return null;
      const value = String(end);
      const inside = document.createElement("span");
      inside.className = "odometer-inside";
      inside.setAttribute("aria-hidden", "true");
      const digits = [...value].filter((character) => /\d/.test(character));
      let digitIndex = 0;
      for (const character of value) {
        if (/\d/.test(character)) {
          const initial = digitIndex === digits.length - 1 ? "0" : "";
          inside.append(buildDigit(initial, character));
          digitIndex += 1;
        } else {
          const mark = document.createElement("span");
          mark.className = "odometer-formatting-mark";
          mark.textContent = character;
          inside.append(mark);
        }
      }
      counter.replaceChildren(inside);
      counter.classList.add("odometer-auto-theme");
      counter.setAttribute("aria-label", value);
      return counter;
    };
    const run = (counter) => {
      if (counter.dataset.omgCounter === "running") return;
      counter.dataset.omgCounter = "running";
      if (reducedMotion) {
        counter.classList.add("omg-counter-complete");
        return;
      }
      // Commit the first ribbon value before promoting the transition so the
      // counter rolls from its reserved initial geometry instead of popping.
      void counter.offsetHeight;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        counter.classList.add("omg-counter-animating");
      }));
      window.setTimeout(() => {
        counter.classList.add("omg-counter-complete");
        counter.classList.remove("omg-counter-animating");
      }, 2050);
    };
    const prepared = counters.map(prepare).filter(Boolean);
    if (!("IntersectionObserver" in window)) {
      prepared.forEach(run);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        run(entry.target);
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.35 });
    prepared.forEach((counter) => observer.observe(counter));
  };

  const revealFrom = (element) => {
    if (element.classList.contains("fadeInUp2")) return { y: 30, opacity: 0 };
    if (element.classList.contains("fadeInRight2")) return { x: 50, opacity: 0 };
    if (element.classList.contains("fadeInLeft2")) return { x: -50, opacity: 0 };
    if (element.classList.contains("backInUp2")) return { y: Math.min(1200, window.innerHeight), scale: 0.7, opacity: 0.7 };
    if (element.classList.contains("slideInLeft")) return { x: -Math.min(2000, window.innerWidth * 1.5), opacity: 0 };
    if (element.classList.contains("zoomIn")) return { scale: 0.3, opacity: 0 };
    return { opacity: 0 };
  };
  const animateReveal = (element) => {
    if (element.dataset.omgRevealed === "true") return;
    element.dataset.omgRevealed = "true";
    const delay = parseSeconds(element.dataset.wowDelay, 0);
    const from = revealFrom(element);
    if (reducedMotion) {
      element.classList.add("animated", "omg-reveal-visible");
      return;
    }
    const fromFrame = {
      opacity: from.opacity ?? 1,
      transform: `translate3d(${from.x || 0}px, ${from.y || 0}px, 0) scale(${from.scale || 1})`,
    };
    if (supportsWebAnimations) {
      const [animation] = animateStaggered(
        [element],
        [fromFrame, { opacity: 1, transform: "translate3d(0,0,0) scale(1)" }],
        { delay, duration: 0.8, easing: POWER3_OUT },
      );
      animation?.finished
        .then(() => element.classList.add("animated", "omg-reveal-visible"))
        .catch(() => {});
    } else if (gsap) {
      gsap.fromTo(element, from, {
        x: 0,
        y: 0,
        scale: 1,
        opacity: 1,
        duration: 0.8,
        delay,
        ease: "power3.out",
        overwrite: "auto",
        onComplete: () => element.classList.add("animated", "omg-reveal-visible"),
      });
    } else {
      element.classList.add("animated", "omg-reveal-visible");
    }
  };
  const initReveals = () => {
    const elements = queryAll(".wow");
    if (!("IntersectionObserver" in window)) {
      elements.forEach(animateReveal);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        animateReveal(entry.target);
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -50px 0px", threshold: 0.01 });
    elements.forEach((element) => observer.observe(element));
  };

  const splitText = (element, useChars) => {
    if (element.dataset.omgSplit === "true") {
      return {
        words: queryAll(".omg-word", element),
        chars: queryAll(".omg-char", element),
      };
    }
    const accessibleText = element.textContent.replace(/\s+/g, " ").trim();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      if (walker.currentNode.nodeValue.trim()) nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      const fragment = document.createDocumentFragment();
      for (const part of node.nodeValue.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          fragment.appendChild(document.createTextNode(part));
          continue;
        }
        const word = document.createElement("span");
        word.className = "omg-word";
        word.setAttribute("aria-hidden", "true");
        if (useChars) {
          for (const character of Array.from(part)) {
            const char = document.createElement("span");
            char.className = "omg-char";
            char.textContent = character;
            word.appendChild(char);
          }
        } else {
          word.textContent = part;
        }
        fragment.appendChild(word);
      }
      node.replaceWith(fragment);
    }
    if (accessibleText && !element.hasAttribute("aria-label")) element.setAttribute("aria-label", accessibleText);
    element.dataset.omgSplit = "true";
    return { words: queryAll(".omg-word", element), chars: queryAll(".omg-char", element) };
  };
  const animateSplitTitle = (element) => {
    if (element.dataset.omgSplitAnimated === "true") return;
    element.dataset.omgSplitAnimated = "true";
    if (reducedMotion) return;

    if (element.classList.contains("wa_title_split_2")) {
      const { words } = splitText(element, false);
      const duration = parseSeconds(element.dataset.duration, 0.75);
      const delay = parseSeconds(element.dataset.delay, 0);
      const stagger = parseSeconds(element.dataset.stagger, 0.02);
      if (supportsWebAnimations) {
        animateStaggered(
          words,
          [
            { opacity: 0, transform: "translate3d(0,20px,0)" },
            { opacity: 1, transform: "translate3d(0,0,0)" },
          ],
          { delay, duration, easing: POWER3_OUT, stagger },
        );
      } else if (gsap) {
        gsap.fromTo(words, { y: 20, opacity: 0 }, {
          y: 0,
          opacity: 1,
          duration,
          delay,
          stagger,
          ease: "power3.out",
        });
      }
      return;
    }

    const { words, chars } = splitText(element, true);
    if (element.classList.contains("wa_split_up")) {
      const delay = parseSeconds(element.dataset.splitDelay, 0);
      if (supportsWebAnimations) {
        animateStaggered(
          chars,
          [
            { opacity: 0, transform: "translate3d(0,50px,0)" },
            { opacity: 1, transform: "translate3d(0,0,0)" },
          ],
          { delay, duration: 0.3, easing: POWER2_OUT, stagger: 0.15 },
        );
      } else if (gsap) {
        gsap.fromTo(chars, { y: 50, opacity: 0 }, {
          y: 0,
          opacity: 1,
          duration: 0.3,
          delay,
          stagger: 0.15,
          ease: "power2.out",
        });
      }
      return;
    }

    const isHeroTitle = element.classList.contains("hero-title");
    const duration = window.innerWidth <= 768
      ? parseSeconds(element.dataset.speed, 1) * 0.3
      : parseSeconds(element.dataset.speed, 1);
    const delay = parseSeconds(element.dataset.delay, 0);
    if (supportsWebAnimations) {
      const fromFrame = {
        ...(isHeroTitle ? {} : { opacity: 0 }),
        transform: "rotateX(-80deg)",
        transformOrigin: "center center -10px",
      };
      animateStaggered(
        chars,
        [
          fromFrame,
          { opacity: 1, transform: "rotateX(0deg)", transformOrigin: "center center -10px" },
        ],
        { delay, duration, easing: POWER3_OUT, fromCenter: true, stagger: 0.05 },
      );
    } else if (gsap) {
      gsap.set(words, { perspective: 1000, transformStyle: "preserve-3d" });
      gsap.fromTo(chars, {
        ...(isHeroTitle ? {} : { opacity: 0 }),
        rotateX: -80,
        transformOrigin: "center center -10px",
      }, {
        opacity: 1,
        rotateX: 0,
        duration,
        delay,
        stagger: { each: 0.05, from: "center" },
        ease: "power3.out",
      });
    }
  };
  const initSplitTitles = () => {
    const titles = queryAll(".wa_title_spilt_1, .wa_title_split_2, .wa_split_up");
    if (reducedMotion || !("IntersectionObserver" in window)) {
      titles.forEach(animateSplitTitle);
      return;
    }

    // Splitting changes DOM structure and makes the first tween initialization
    // force style/layout work. Do that small, deterministic preparation once
    // after LCP instead of when multiple titles cross the viewport during a
    // fast forward/reverse scroll.
    for (const title of titles) {
      splitText(title, !title.classList.contains("wa_title_split_2"));
    }

    const reversible = titles.filter((title) => title.classList.contains("wa_split_up"));
    if (gsap && ScrollTrigger && reversible.length) {
      gsap.registerPlugin(ScrollTrigger);
      for (const element of reversible) {
        element.dataset.omgSplitAnimated = "true";
        const { chars } = splitText(element, true);
        gsap.set(chars, { y: 50, opacity: 0 });
        gsap.to(chars, {
          y: 0,
          opacity: 1,
          duration: 0.3,
          delay: parseSeconds(element.dataset.splitDelay, 0),
          stagger: 0.15,
          ease: "power2.out",
          scrollTrigger: {
            trigger: element,
            start: "top 86%",
            toggleActions: "play none none reverse",
          },
        });
      }
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        animateSplitTitle(entry.target);
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -20% 0px", threshold: 0.01 });
    titles.filter((title) => !reversible.includes(title) || !gsap || !ScrollTrigger).forEach((title) => observer.observe(title));
  };

  const initButtonTextMotion = () => {
    if (!finePointer || reducedMotion) return;
    const charMap = new WeakMap();
    for (const button of queryAll(".wa_btn_split_1")) {
      const text = button.querySelector(".text") || button;
      charMap.set(button, splitText(text, true).chars);
    }
    document.addEventListener("pointerover", (event) => {
      const button = event.target instanceof Element ? event.target.closest(".wa_btn_split_1") : null;
      if (!button || button.contains(event.relatedTarget)) return;
      const chars = charMap.get(button) || [];
      if (gsap) {
        gsap.fromTo(chars, { y: (index) => index % 2 ? 30 : -30, opacity: 0.5 }, {
          y: 0,
          opacity: 1,
          duration: 0.4,
          stagger: 0.05,
          ease: "power2.out",
          overwrite: true,
        });
      }
    });
  };

  const initPointerMotion = () => {
    if (!finePointer || reducedMotion) return;
    const states = new Map();
    let removeTask = null;
    const ensureTask = () => {
      if (removeTask) return;
      removeTask = scheduler.add(() => {
        let moving = false;
        for (const [element, state] of states) {
          state.x += (state.targetX - state.x) * 0.16;
          state.y += (state.targetY - state.y) * 0.16;
          if (Math.abs(state.targetX - state.x) > 0.05 || Math.abs(state.targetY - state.y) > 0.05) moving = true;
          element.style.setProperty("--omg-magnetic-x", `${state.x.toFixed(2)}px`);
          element.style.setProperty("--omg-magnetic-y", `${state.y.toFixed(2)}px`);
        }
        if (!moving) {
          removeTask?.();
          removeTask = null;
        }
      });
    };
    const setTargets = (element, x, y) => {
      const state = states.get(element) || { x: 0, y: 0, targetX: 0, targetY: 0 };
      state.targetX = x;
      state.targetY = y;
      states.set(element, state);
      ensureTask();
    };
    let active = null;
    let rect = null;
    document.addEventListener("pointerover", (event) => {
      const trigger = event.target instanceof Element ? event.target.closest(".wa_magnetic_btn_1, .wa_magnetic_1_trigger, .wa_tilt") : null;
      if (!trigger || trigger.contains(event.relatedTarget)) return;
      active = trigger;
      rect = trigger.getBoundingClientRect();
    });
    document.addEventListener("pointermove", (event) => {
      if (!active || !rect) return;
      const xRatio = (event.clientX - rect.left) / Math.max(1, rect.width) - 0.5;
      const yRatio = (event.clientY - rect.top) / Math.max(1, rect.height) - 0.5;
      if (active.classList.contains("wa_tilt")) {
        const target = active.querySelector(".wa_tilt_elm");
        if (target) target.style.setProperty("--omg-tilt-y", `${(xRatio * 11).toFixed(2)}deg`);
        return;
      }
      if (active.classList.contains("wa_magnetic_1_trigger")) {
        for (const element of queryAll(".wa_magnetic_1_elm", active)) setTargets(element, xRatio * 30, yRatio * 30);
      } else {
        setTargets(active, xRatio * 10, yRatio * 10);
      }
    }, { passive: true });
    document.addEventListener("pointerout", (event) => {
      if (!active || active.contains(event.relatedTarget)) return;
      if (active.classList.contains("wa_tilt")) active.querySelector(".wa_tilt_elm")?.style.setProperty("--omg-tilt-y", "0deg");
      else if (active.classList.contains("wa_magnetic_1_trigger")) queryAll(".wa_magnetic_1_elm", active).forEach((element) => setTargets(element, 0, 0));
      else setTargets(active, 0, 0);
      active = null;
      rect = null;
    });
  };

  const initCursor = () => {
    if (!finePointer || reducedMotion) return;
    const cursor = document.querySelector(".wa-cursor") || document.body.appendChild(Object.assign(document.createElement("div"), { className: "wa-cursor" }));
    if (!cursor.querySelector(".wa-cursor-text")) cursor.appendChild(Object.assign(document.createElement("div"), { className: "wa-cursor-text" }));
    let x = -100;
    let y = -100;
    let targetX = x;
    let targetY = y;
    let removeTask = null;
    const ensureMotion = () => {
      if (removeTask) return;
      removeTask = scheduler.add(() => {
        x += (targetX - x) * 0.24;
        y += (targetY - y) * 0.24;
        cursor.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0)`;
        if (Math.abs(targetX - x) < 0.05 && Math.abs(targetY - y) < 0.05) {
          removeTask?.();
          removeTask = null;
        }
      });
    };
    document.addEventListener("pointermove", (event) => {
      targetX = event.clientX;
      targetY = event.clientY;
      cursor.classList.add("-visible");
      ensureMotion();
    }, { passive: true });
    document.addEventListener("pointerover", (event) => {
      if (event.target instanceof Element && event.target.closest("a,input,textarea,select,button,[role='button']")) cursor.classList.add("-pointer");
    });
    document.addEventListener("pointerout", (event) => {
      if (event.target instanceof Element && event.target.closest("a,input,textarea,select,button,[role='button']") && !(event.relatedTarget instanceof Element && event.relatedTarget.closest("a,input,textarea,select,button,[role='button']"))) cursor.classList.remove("-pointer");
    });
    document.addEventListener("pointerdown", () => cursor.classList.add("-active"));
    document.addEventListener("pointerup", () => cursor.classList.remove("-active"));
    document.documentElement.addEventListener("mouseleave", () => cursor.classList.remove("-visible"));
    document.documentElement.addEventListener("mouseenter", () => cursor.classList.add("-visible"));
  };

  const initCursorNoise = () => {
    const canvas = document.getElementById("wa_cursor_noise");
    if (!(canvas instanceof HTMLCanvasElement)) return;
    canvas.setAttribute("aria-hidden", "true");
    if (!finePointer || reducedMotion) {
      canvas.hidden = true;
      return;
    }
    const context = canvas.getContext("2d", { alpha: true });
    const hero = canvas.closest(".as-hero-1-area") || canvas;
    if (!context) return;
    let rect = canvas.getBoundingClientRect();
    let particles = [];
    let removeTask = null;
    let lastSpawn = 0;
    const resize = () => {
      rect = canvas.getBoundingClientRect();
      const ratio = Math.min(1.5, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const ensureAnimation = () => {
      if (removeTask) return;
      removeTask = scheduler.add(() => {
        context.clearRect(0, 0, rect.width, rect.height);
        particles = particles.filter((particle) => {
          particle.life += 1;
          particle.x += particle.vx;
          particle.y += particle.vy;
          particle.alpha = Math.max(0, particle.alpha - 0.025);
          context.globalAlpha = particle.alpha;
          context.fillStyle = "rgba(0,0,0,.5)";
          context.fillRect(particle.x, particle.y, 2, 2);
          return particle.life < 40;
        });
        context.globalAlpha = 1;
        if (!particles.length) {
          removeTask?.();
          removeTask = null;
        }
      });
    };
    hero.addEventListener("pointermove", (event) => {
      const now = performance.now();
      if (now - lastSpawn < 24) return;
      lastSpawn = now;
      const centerX = event.clientX - rect.left;
      const centerY = event.clientY - rect.top;
      for (let index = 0; index < 16 && particles.length < 320; index += 1) {
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.random() * 250;
        particles.push({
          x: centerX + Math.cos(angle) * distance,
          y: centerY + Math.sin(angle) * distance,
          vx: Math.cos(angle),
          vy: Math.sin(angle),
          alpha: 1,
          life: 0,
        });
      }
      ensureAnimation();
    }, { passive: true });
    resize();
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(resize, 160);
    }, { passive: true });
  };

  const initPlaceholderTyping = () => {
    const fields = queryAll(".wa_placeholder[placeholder]");
    if (reducedMotion || !("IntersectionObserver" in window)) return;
    const states = new Map();
    let removeTask = null;
    const ensureTask = () => {
      if (removeTask) return;
      removeTask = scheduler.add((timeMs) => {
        for (const [field, state] of Array.from(states)) {
          const index = Math.min(state.text.length, Math.floor((timeMs - state.start) / 70));
          if (index !== state.index) {
            field.placeholder = state.text.slice(0, Math.max(0, index));
            state.index = index;
          }
          if (index >= state.text.length) states.delete(field);
        }
        if (!states.size) {
          removeTask?.();
          removeTask = null;
        }
      });
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const field = entry.target;
        const text = field.placeholder;
        field.placeholder = "";
        states.set(field, { text, start: performance.now() + Number(field.dataset.startDelay || 0), index: -1 });
        ensureTask();
        observer.unobserve(field);
      }
    }, { threshold: 0.5 });
    fields.forEach((field) => observer.observe(field));
  };

  const initTeamState = () => {
    const wrap = document.querySelector(".as-team-1-wrap");
    if (!wrap || !("IntersectionObserver" in window)) return;
    const members = queryAll(".as-team-1-member", wrap);
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) members.forEach((member) => member.classList.toggle("is_active", entry.isIntersecting));
    }, { threshold: 0.1 });
    observer.observe(wrap);
  };

  const initScrollTimelines = () => {
    if (!gsap || !ScrollTrigger || reducedMotion) return;
    gsap.registerPlugin(ScrollTrigger);
    gsap.config({ nullTargetWarn: false });
    ScrollTrigger.config({ limitCallbacks: true });

    const addResponsive = (query, factory) => {
      if (gsap.matchMedia) gsap.matchMedia().add(query, factory);
      else if (window.matchMedia(query).matches) factory();
    };

    if (document.querySelector(".t1_ani_trigger")) {
      addResponsive("(min-width: 1600px)", () => {
        const timeline = gsap.timeline({
          scrollTrigger: { trigger: ".t1_ani_trigger", start: "top 10%", end: "top -70%", scrub: true },
        });
        timeline.from(".as-team-1-member-ani:nth-of-type(1)", { x: 1187, y: -828, scale: 0.7, ease: "none" })
          .from(".as-team-1-member-ani:nth-of-type(2)", { x: 830, y: -828, scale: 0.7, ease: "none" }, "<50%")
          .from(".as-team-1-member-ani:nth-of-type(3)", { x: 460, y: -828, scale: 0.7, ease: "none" }, "<50%")
          .from(".as-team-1-member-ani:nth-of-type(4)", { x: 100, y: -828, scale: 0.7, ease: "none" }, "<50%");
      });
    }

    if (document.querySelector(".partner1_trigger")) {
      addResponsive("(min-width: 1200px)", () => {
        const timeline = gsap.timeline({
          scrollTrigger: { trigger: ".partner1_trigger", start: "top 90%", end: "top -10%", scrub: true },
        });
        timeline.from(".as-partner-1-cloud .cloud-1", { x: 150, ease: "none" })
          .from(".as-partner-1-cloud .cloud-2", { x: -150, ease: "none" }, "<")
          .from(".as-partner-1-cloud .rocket", { y: 300, x: 100, rotation: -30, ease: "none" }, "<10%");
      });
    }

    if (document.querySelector(".cta1_trigger")) {
      addResponsive("(min-width: 992px)", () => {
        const timeline = gsap.timeline({
          scrollTrigger: { trigger: ".cta1_trigger", start: "top 50%", end: "top top", scrub: true },
        });
        timeline.from(".as-cta-1-hand-1", { x: 150, y: 150, ease: "none" })
          .from(".as-cta-1-hand-2", { x: -150, y: -150, ease: "none" }, "<")
          .from(".as-cta-1-img-1", { x: 250, rotation: 30, opacity: 0, ease: "none" }, "<10%")
          .from(".as-cta-1-img-2", { x: -250, y: 150, rotation: -30, opacity: 0, ease: "none" }, "<10%")
          .from(".as-cta-1-content .title-1", { x: 100, y: -50, opacity: 0, ease: "none" }, "<10%")
          .from(".as-cta-1-content .title-2", { x: 250, y: -150, opacity: 0, ease: "none" }, "<10%")
          .from(".as-cta-1-content .btn-wrap", { x: 250, y: -150, opacity: 0, ease: "none" }, "<10%");
      });
    }

    if (document.querySelector(".portfolio1_pin_elm_trigger")) {
      addResponsive("(min-width: 992px)", () => {
        const pin = document.querySelector(".portfolio1_pin_elm");
        ScrollTrigger.create({
          trigger: ".portfolio1_pin_elm_trigger",
          start: "top 10%",
          end: "bottom 85%",
          pin,
          pinSpacing: false,
          anticipatePin: 1,
        });
        gsap.to(".as-portfolio-1-sec-title .big-title", {
          scale: 0.5,
          ease: "none",
          scrollTrigger: { trigger: ".portfolio1_pin_elm_trigger", start: "top 10%", end: "bottom bottom", scrub: true },
        });
      });
    }

    addTriggerDiagnostic(".t1_ani_trigger", "gsap-scrolltrigger");
    addTriggerDiagnostic(".partner1_trigger", "gsap-scrolltrigger");
    addTriggerDiagnostic(".cta1_trigger", "gsap-scrolltrigger");
    addTriggerDiagnostic(".portfolio1_pin_elm_trigger", "gsap-scrolltrigger");
  };

  const initStaticHelpers = () => {
    const revealBackground = (element) => {
      const url = element.dataset.background;
      if (url) element.style.backgroundImage = `url("${url.replace(/["\\]/g, "\\$&")}")`;
    };
    const lazyTargets = [...queryAll("[data-background]"), ...queryAll(".e-con.e-parent:not(.e-lazyloaded)")];
    const loadTarget = (element) => {
      if (element.hasAttribute("data-background")) revealBackground(element);
      if (element.classList.contains("e-parent")) element.classList.add("e-lazyloaded");
    };
    const isNearViewport = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom >= -200 && rect.top <= window.innerHeight + 300;
    };
    const deferredTargets = [];
    for (const element of lazyTargets) {
      if (isNearViewport(element)) loadTarget(element);
      else deferredTargets.push(element);
    }
    if (deferredTargets.length && "IntersectionObserver" in window) {
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          loadTarget(entry.target);
          observer.unobserve(entry.target);
        }
      }, { rootMargin: "400px 0px", threshold: 0.01 });
      deferredTargets.forEach((element) => observer.observe(element));
    } else {
      deferredTargets.forEach(loadTarget);
    }
    const year = String(new Date().getFullYear());
    for (const element of queryAll(".copyright-year")) element.textContent = year;
    document.querySelector("#wa_liquid_img .hero-main-img")?.classList.add("omg-hero-reveal");

  };

  const ready = () => {
    initStaticHelpers();
    initSmoothScroll();
    initNavigation();
    initTabs();
    initAccordions();
    initConsent();
    initNiceSelects();
    initLocalForms();
    initMarquees();
    initCounters();
    initReveals();
    initSplitTitles();
    initButtonTextMotion();
    initPointerMotion();
    initCursor();
    initCursorNoise();
    initPlaceholderTyping();
    initTeamState();
    initScrollTimelines();

    addTriggerDiagnostic(".wow", perf.animationOwners.reveals);
    addTriggerDiagnostic(".wa_title_spilt_1, .wa_title_split_2, .wa_split_up", perf.animationOwners.splitTitles);
    addTriggerDiagnostic(".wa_marquee_left_nopause, .wa_marquee_right_nopause, .wa_marquee_down_top", perf.animationOwners.marquees);
    addTriggerDiagnostic(".odometer[data-count]", perf.animationOwners.counters);
    addTriggerDiagnostic(".wa_accordion_item", "native-event-delegation");

    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        measureMarquees();
        requestScrollRefresh();
      }, 220);
    }, { passive: true });
    window.addEventListener("load", requestScrollRefresh, { once: true });
    document.fonts?.ready?.then(requestScrollRefresh);

    perf.ready = true;
    perf.schedulerTasks = scheduler.size();
    perf.scrollTriggerCount = ScrollTrigger?.getAll?.().length || 0;
    document.documentElement.dataset.omgRuntime = "ready";
    window.dispatchEvent(new CustomEvent("omg:ready", { detail: perf }));
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
})();
