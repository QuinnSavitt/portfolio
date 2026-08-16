/*------------------------------------------------
    Games index

    Add a game by dropping an entry into GAMES below.
      id      unique + stable, used as the localStorage key
      title   card heading
      tagline one or two lines of description
      icon    themefisher icon class
      url     page to open, or null while it is still being built
      daily   true if there is a fresh puzzle every day
      live    false renders a "coming soon" card with the play button off
-------------------------------------------------*/
(function () {
    "use strict";

    var GAMES = [
        {
            id: "rocket",
            title: "Daily Rocket",
            tagline: "Pick an engine, load your fuel, sweep the beacons and land it on the pad. Same rocket, same sky, everyone, every day.",
            icon: "tf-hotairballoon",
            url: "games/rocket/index.html",
            daily: true,
            live: true
        },
        {
            id: "rally",
            title: "Daily Rally",
            tagline: "One car, one procedurally generated rally stage, one day. Trust the co-driver, beat the clock. Fastest time wins.",
            icon: "tf-speedometer",
            url: "games/rally/index.html",
            daily: true,
            live: true
        }
    ];

    var STORAGE_PREFIX = "qs-game-";
    var grid = document.getElementById("games-grid");
    var note = document.getElementById("games-note");
    var empty = document.getElementById("games-empty");
    var viewNav = document.getElementById("games-view");
    var view = "all";
    var ticker = null;

    // Local calendar day, the key a daily game is stamped with once played.
    function todayKey(date) {
        var now = date || new Date();
        var month = now.getMonth() + 1;
        var day = now.getDate();
        return now.getFullYear() + "-" + (month < 10 ? "0" : "") + month + "-" + (day < 10 ? "0" : "") + day;
    }

    function readStore(key) {
        try {
            return window.localStorage.getItem(key);
        } catch (err) {
            return null;
        }
    }

    function writeStore(key, value) {
        try {
            window.localStorage.setItem(key, value);
        } catch (err) {
            return false;
        }
        return true;
    }

    function playedToday(id) {
        return readStore(STORAGE_PREFIX + id + "-played") === todayKey();
    }

    function markPlayed(id) {
        return writeStore(STORAGE_PREFIX + id + "-played", todayKey());
    }

    function msUntilReset() {
        var now = new Date();
        var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
        return next.getTime() - now.getTime();
    }

    function pad(value) {
        return (value < 10 ? "0" : "") + value;
    }

    function resetCountdown() {
        var left = Math.max(msUntilReset(), 0);
        var hours = Math.floor(left / 3600000);
        var minutes = Math.floor((left % 3600000) / 60000);
        var seconds = Math.floor((left % 60000) / 1000);
        return pad(hours) + ":" + pad(minutes) + ":" + pad(seconds);
    }

    function matchesView(game) {
        return view === "all" || game.daily;
    }

    function cardMarkup(game) {
        var badges = "";
        var action;

        if (game.daily) {
            badges += "<span class=\"game-badge daily\">Daily</span>";
        }
        if (!game.live) {
            badges += "<span class=\"game-badge soon\">Coming soon</span>";
        } else if (game.daily && playedToday(game.id)) {
            badges += "<span class=\"game-badge played\">Played today</span>";
        }

        if (game.live && game.url) {
            action = "<a href=\"" + game.url + "\" class=\"game-play\">" +
                (game.daily ? "Play today's" : "Play") + "</a>";
        } else {
            action = "<span class=\"game-play disabled\">In the works</span>";
        }

        return "<div class=\"col-xs-12 col-sm-6 col-md-3\">" +
            "<div class=\"game-item\">" +
            "<span class=\"game-hex\"><i class=\"" + game.icon + "\"></i></span>" +
            "<h4>" + game.title + "</h4>" +
            "<p class=\"game-tagline\">" + game.tagline + "</p>" +
            "<div class=\"game-meta\">" + badges + "</div>" +
            action +
            "</div>" +
            "</div>";
    }

    function countDaily() {
        var total = 0;
        var i;
        for (i = 0; i < GAMES.length; i++) {
            if (GAMES[i].daily) {
                total++;
            }
        }
        return total;
    }

    function updateNote() {
        if (!note) {
            return;
        }
        if (view === "daily") {
            note.innerHTML = "Every puzzle resets at midnight &mdash; next in <b>" + resetCountdown() + "</b>";
        } else {
            note.innerHTML = GAMES.length + " games &mdash; " + countDaily() + " with a fresh puzzle every day";
        }
    }

    function startTicker() {
        if (ticker) {
            window.clearInterval(ticker);
            ticker = null;
        }
        if (view === "daily") {
            ticker = window.setInterval(updateNote, 1000);
        }
    }

    function render() {
        var markup = "";
        var shown = 0;
        var i;

        for (i = 0; i < GAMES.length; i++) {
            if (matchesView(GAMES[i])) {
                markup += cardMarkup(GAMES[i]);
                shown++;
            }
        }

        if (grid) {
            grid.innerHTML = markup;
        }
        if (empty) {
            empty.style.display = shown ? "none" : "block";
        }
        updateNote();
        startTicker();
    }

    function setView(next) {
        view = next === "daily" ? "daily" : "all";

        if (viewNav) {
            var links = viewNav.getElementsByTagName("a");
            var i;
            for (i = 0; i < links.length; i++) {
                if (links[i].getAttribute("data-view") === view) {
                    links[i].className = "link active";
                } else {
                    links[i].className = "link";
                }
            }
        }

        render();
    }

    function viewFromHash() {
        return window.location.hash.replace("#", "") === "daily" ? "daily" : "all";
    }

    function bindNav() {
        if (!viewNav) {
            return;
        }
        viewNav.onclick = function (event) {
            var target = (event.target || event.srcElement);
            var next = target.getAttribute && target.getAttribute("data-view");
            if (!next) {
                return true;
            }
            setView(next);
            return true; // let the hash update so the view is linkable
        };
    }

    function init() {
        bindNav();
        setView(viewFromHash());
    }

    // Handy for the games themselves later on: QuinnGames.markPlayed("cipher")
    window.QuinnGames = {
        todayKey: todayKey,
        playedToday: playedToday,
        markPlayed: markPlayed,
        msUntilReset: msUntilReset
    };

    window.onhashchange = function () {
        var next = viewFromHash();
        if (next !== view) {
            setView(next);
        }
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, false);
    } else {
        init();
    }
})();
