/*------------------------------------------------
    Fun stuff

    Shared list of the toy pages plus the random hop
    between them. Used by fun.html and by each toy
    page's "Take Me Somewhere Else Fun" button.
-------------------------------------------------*/
(function () {
    "use strict";

    var FUN_PAGES = [
        "visualizer.html",
        "algs.html",
        "spirograph.html"
    ];

    function goToRandomPage(excludeCurrent) {
        var current = window.location.pathname.split("/").pop();
        var choices = [];
        var i;
        for (i = 0; i < FUN_PAGES.length; i++) {
            if (!excludeCurrent || FUN_PAGES[i] !== current) {
                choices.push(FUN_PAGES[i]);
            }
        }
        if (!choices.length) {
            return;
        }
        window.location.href = choices[Math.floor(Math.random() * choices.length)];
    }

    window.goToRandomPage = goToRandomPage;
}());
