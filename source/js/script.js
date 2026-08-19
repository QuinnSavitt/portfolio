/**
 * Site-wide behaviour.
 *
 * Loaded with `defer`, so the DOM is fully parsed by the time this runs and
 * no ready-callback is needed.
 *
 * This file used to require jQuery, and with it Bootstrap's JS bundle, the
 * niceScroll plugin and the Slick carousel - roughly 370KB across every page.
 * Most of it drove selectors that no longer exist in the markup (.testimonials,
 * .skill-lavel, .switcher-trigger, .color-options); the rest is now handled by
 * CSS or by the few lines below.
 */
(function () {
	"use strict";

	/* ---------------------------------------------------------------
		Dark mode

		The inline script in <head> has already applied the stored choice
		before first paint. This only handles flipping it.
	--------------------------------------------------------------- */
	var root = document.documentElement;
	var toggle = document.querySelector(".theme-toggle");

	if (toggle) {
		var FADE_MS = 350;
		var fadeTimer = null;

		var syncToggle = function () {
			var dark = root.classList.contains("dark");
			toggle.setAttribute("aria-pressed", dark ? "true" : "false");
			var icon = toggle.querySelector("i");
			if (icon) {
				icon.className = dark ? "tf-ion-ios-sunny" : "tf-ion-ios-moon";
			}
		};

		toggle.addEventListener("click", function () {
			// Only fade for the duration of the swap, so page loads stay instant.
			root.classList.add("theme-fading");
			window.clearTimeout(fadeTimer);
			fadeTimer = window.setTimeout(function () {
				root.classList.remove("theme-fading");
			}, FADE_MS + 60);

			var dark = root.classList.toggle("dark");
			try {
				localStorage.setItem("qs-theme", dark ? "dark" : "light");
			} catch (e) {}
			syncToggle();
		});

		syncToggle();
	}

	/* ---------------------------------------------------------------
		Intro wipe safety net

		The wipe is a pure CSS animation and needs no help to run. But its
		first frame is the one where the bars cover the whole viewport, so if
		the animation is stalled before it ever ticks - a throttled renderer,
		a tab that never gets a frame - the page stays hidden behind them.

		This is deliberately not the old arrangement, where JS *drove* the
		reveal and a missed load event meant it never happened. Here the
		animation reveals the page on its own; this only guarantees the
		element is gone, on animationend or on a timeout, whichever comes
		first.
	--------------------------------------------------------------- */
	var preloader = document.querySelector(".preloader");

	if (preloader) {
		var retire = function () {
			preloader.classList.add("is-done");
		};

		preloader.addEventListener("animationend", retire);
		// Comfortably past the ~0.65s wipe, short enough that a stalled
		// animation is never left covering the page for long.
		window.setTimeout(retire, 1200);
	}

	/* ---------------------------------------------------------------
		Project grid

		Isotope is only loaded on projects.html, so both the library and
		the grid have to be present before any of this runs.
	--------------------------------------------------------------- */
	var grid = document.querySelector(".isotope-gutter");

	if (grid && typeof window.Isotope === "function") {
		var iso = new window.Isotope(grid, {
			itemSelector: "[class^=\"col-\"]",
			percentPosition: true
		});

		var filters = document.querySelectorAll(".filter a");

		Array.prototype.forEach.call(filters, function (link) {
			link.addEventListener("click", function (event) {
				event.preventDefault();

				Array.prototype.forEach.call(filters, function (other) {
					other.classList.remove("active");
				});
				link.classList.add("active");

				iso.arrange({ filter: link.getAttribute("data-filter") });
			});
		});
	}
})();
