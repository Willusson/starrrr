/* ==========================================================================
   Звезда — cosmic scene renderer (HTML5 Canvas 2D only).
   No SVG. The star, its bloom and every ray are drawn with gradients and
   additive ("lighter") compositing.
   ========================================================================== */
(function () {
  'use strict';

  var canvas = document.getElementById('cosmos');
  /* If canvas isn't supported, the CSS void + glow fallback + text remain. */
  if (!canvas || typeof canvas.getContext !== 'function' || !(window.requestAnimationFrame)) {
    return;
  }
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { reduceMotion = false; }

  /* ---- state ------------------------------------------------------------ */
  var W = 0, H = 0, CX = 0, CY = 0, DPR = 1;
  var minSide = 0, maxR = 0, unit = 1, starScale = 1;
  var stars = [], rays = [];
  var sprites = Object.create(null);

  var pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  var rafId = 0, running = false, startTime = 0, pausedAt = 0;

  /* ---- geometry helpers ------------------------------------------------- */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function smoothstep(a, b, x) {
    var u = (x - a) / (b - a);
    if (u < 0) u = 0;
    if (u > 1) u = 1;
    return u * u * (3 - 2 * u);
  }
  function jitter(v) { return (Math.random() - 0.5) * v; }
  function rnd2(lo, hi) { return lo + Math.random() * (hi - lo); }
  function rgba(rgb, a) {
    return 'rgba(' + rgb + ',' + clamp(a, 0, 1).toFixed(3) + ')';
  }

  /* ==========================================================================
     Sprites (built once — viewport-independent).
     ========================================================================== */
  function radialSprite(size, stops) {
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    var g = c.getContext('2d');
    var r = size / 2;
    var grad = g.createRadialGradient(r, r, 0, r, r, r);
    for (var i = 0; i < stops.length; i++) grad.addColorStop(stops[i][0], stops[i][1]);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  /* A ray: a multi-pass tapered beam baked into one sprite.
     The sprite's bottom-centre is the anchor (where the star sits). */
  function raySprite(width, height, rgb, passes) {
    var c = document.createElement('canvas');
    c.width = width; c.height = height;
    var g = c.getContext('2d');
    g.translate(width / 2, height); /* origin at bottom-centre */
    var positions = [0, 0.04, 0.13, 0.40, 0.72, 1];
    var intensity = [0, 0.36, 1, 0.66, 0.24, 0];
    for (var p = 0; p < passes.length; p++) {
      var w = width * passes[p][0];
      var a = passes[p][1];
      var grad = g.createLinearGradient(0, 0, 0, -height);
      for (var i = 0; i < positions.length; i++) {
        grad.addColorStop(positions[i], rgba(rgb, intensity[i] * a));
      }
      g.beginPath();
      g.moveTo(-w / 2, 0);
      g.lineTo(w / 2, 0);
      g.lineTo(w * 0.13, -height);
      g.lineTo(-w * 0.13, -height);
      g.closePath();
      g.fillStyle = grad;
      g.fill();
    }
    c._width = width;
    return c;
  }

  function buildSprites() {
    if (sprites.star) return;

    sprites.star = radialSprite(512, [
      [0.00, '#ffffff'],
      [0.045, 'rgba(255,255,255,0.94)'],
      [0.12, 'rgba(240,246,255,0.60)'],
      [0.22, 'rgba(206,222,255,0.30)'],
      [0.36, 'rgba(158,186,255,0.13)'],
      [0.55, 'rgba(108,142,246,0.045)'],
      [0.78, 'rgba(70,102,220,0.011)'],
      [1.00, 'rgba(40,66,180,0)']
    ]);

    sprites.core = radialSprite(256, [
      [0.00, '#ffffff'],
      [0.16, 'rgba(255,255,255,0.96)'],
      [0.32, 'rgba(248,251,255,0.78)'],
      [0.50, 'rgba(226,238,255,0.40)'],
      [0.72, 'rgba(186,208,255,0.15)'],
      [1.00, 'rgba(140,170,255,0)']
    ]);

    sprites.cool = radialSprite(64, [
      [0.00, '#ffffff'],
      [0.08, 'rgba(238,244,255,0.92)'],
      [0.20, 'rgba(186,212,255,0.32)'],
      [0.45, 'rgba(124,162,250,0.08)'],
      [1.00, 'rgba(66,106,218,0)']
    ]);

    sprites.warm = radialSprite(64, [
      [0.00, 'rgba(255,252,245,1)'],
      [0.08, 'rgba(255,244,220,0.88)'],
      [0.20, 'rgba(255,222,170,0.30)'],
      [0.45, 'rgba(255,190,120,0.08)'],
      [1.00, 'rgba(255,160,80,0)']
    ]);

    sprites.rayWhite  = raySprite(72, 1040, '255,255,255', [[0.98,0.05],[0.8,0.09],[0.46,0.20],[0.22,0.42],[0.09,0.72],[0.035,1]]);
    sprites.rayBlue   = raySprite(72, 1040, '186,214,255', [[0.98,0.05],[0.8,0.08],[0.46,0.18],[0.22,0.36],[0.09,0.62],[0.035,0.96]]);
    sprites.rayViolet = raySprite(72, 1040, '195,184,255', [[0.98,0.05],[0.8,0.09],[0.46,0.20],[0.22,0.44],[0.09,0.76],[0.035,1.1]]);
    sprites.rayHot    = raySprite(64, 1040, '255,255,255', [[0.36,0.14],[0.16,0.48],[0.055,1]]);
  }

  /* ---- particle / ray arrays (normalized; stable across resizes) ------- */
  function buildStars() {
    stars.length = 0;
    var target = clamp(Math.round((W * H) / 12000), 70, 270);
    if (reduceMotion) target = Math.round(target * 0.92);
    for (var i = 0; i < target; i++) {
      var bright = Math.random();
      stars.push({
        nx: Math.random(),
        ny: Math.random(),
        size: (0.45 + Math.pow(bright, 2.2) * 2.4) * starScale,
        alpha: 0.12 + bright * 0.52,
        speed: 0.36 + Math.random() * 1.5,
        phase: Math.random() * 6.283,
        warm: Math.random() < 0.22
      });
    }
  }

  function buildRays() {
    rays.length = 0;
    var longCount = minSide < 640 ? 3 : 4;
    var midCount  = minSide < 640 ? 5 : 7;
    var shortCount = minSide < 640 ? 6 : 9;
    var base = Math.random() * 6.283;
    var softSet = [sprites.rayWhite, sprites.rayWhite, sprites.rayBlue,
                   sprites.rayWhite, sprites.rayViolet, sprites.rayBlue];
    var i, a;

    for (i = 0; i < longCount; i++) {
      a = base + (6.2832 / longCount) * i + jitter(0.16);
      rays.push({
        angle: a,
        lenN: rnd2(0.62, 0.9),
        widthN: (2.7 + Math.random() * 1.7),
        alpha: rnd2(0.20, 0.34),
        speed: 0.42 + Math.random() * 0.5,
        phase: Math.random() * 6.283,
        body: sprites.rayWhite,
        hot: sprites.rayHot
      });
    }
    for (i = 0; i < midCount; i++) {
      a = base + (6.2832 / midCount) * (i + 0.5) + jitter(0.22);
      rays.push({
        angle: a,
        lenN: rnd2(0.26, 0.46),
        widthN: (1.7 + Math.random() * 1.1),
        alpha: rnd2(0.14, 0.26),
        speed: 0.6 + Math.random() * 0.7,
        phase: Math.random() * 6.283,
        body: softSet[(Math.random() * softSet.length) | 0],
        hot: Math.random() < 0.55 ? sprites.rayHot : null
      });
    }
    for (i = 0; i < shortCount; i++) {
      a = base + (6.2832 / shortCount) * (i + 0.25) + jitter(0.32);
      rays.push({
        angle: a,
        lenN: rnd2(0.10, 0.20),
        widthN: (1.0 + Math.random() * 0.8),
        alpha: rnd2(0.10, 0.20),
        speed: 0.85 + Math.random() * 1.2,
        phase: Math.random() * 6.283,
        body: softSet[(Math.random() * softSet.length) | 0],
        hot: null
      });
    }
  }
  /* ---- measurement ------------------------------------------------------ */
  function measure() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width) || window.innerWidth || 1);
    H = Math.max(1, Math.round(rect.height) || window.innerHeight || 1);
    var cap = (W * H) > 1344000 ? 1.5 : 2;
    DPR = Math.min(window.devicePixelRatio || 1, cap);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    CX = W / 2;
    CY = H / 2;
    minSide = Math.min(W, H);
    maxR = Math.sqrt(W * W + H * H) / 2;
    unit = Math.min(2.1, Math.max(0.7, minSide / 880));
    starScale = Math.min(1.6, Math.max(0.75, minSide / 900));
  }

  /* ---- drawing ---------------------------------------------------------- */
  function drawField(t, pdx, pdy) {
    var i, s, tw, a, d, x, y;
    for (i = 0; i < stars.length; i++) {
      s = stars[i];
      tw = 0.5 + 0.5 * Math.sin(t * s.speed + s.phase);
      tw = tw * tw * (3 - 2 * tw); /* smooth, organic fade */
      a = s.alpha * (0.12 + 0.88 * tw);
      if (a < 0.01) continue;
      d = s.size * (5 + 3.2 * tw);
      x = s.nx * W + pdx * 0.5;
      y = s.ny * H + pdy * 0.5;
      ctx.globalAlpha = a < 1 ? a : 1;
      ctx.drawImage(s.warm ? sprites.warm : sprites.cool, x - d / 2, y - d / 2, d, d);
    }
  }

  function drawStar(pulse, lum, micro) {
    var layers = [
      [0.62, 0.16],
      [0.32, 0.26],
      [0.16, 0.40],
      [0.072, 0.62],
      [0.019, 0.92]
    ];
    for (var i = 0; i < layers.length; i++) {
      var d = minSide * layers[i][0] * pulse;
      var a = layers[i][1] * lum;
      if (a <= 0.002) continue;
      ctx.globalAlpha = a < 1 ? a : 1;
      ctx.drawImage(sprites.star, CX - d / 2, CY - d / 2, d, d);
    }
    /* piercing, white-hot heart */
    var cd = minSide * 0.0085 * pulse;
    ctx.globalAlpha = clamp(0.96 * lum * micro, 0, 1);
    ctx.drawImage(sprites.core, CX - cd / 2, CY - cd / 2, cd, cd);
  }

  function drawRays(t, pulse, lum, rayIntro) {
    var fan = t * 0.011; /* slow drift of the whole fan */
    var i, r, shim, shim2, flick, len, alpha, ang;
    for (i = 0; i < rays.length; i++) {
      r = rays[i];
      shim = 0.5 + 0.5 * Math.sin(t * r.speed + r.phase);
      shim2 = 0.5 + 0.5 * Math.sin(t * r.speed * 2.35 + r.phase * 1.7);
      flick = 0.55 + 0.45 * (shim * 0.7 + shim2 * 0.3);
      len = r.lenN * maxR * (0.78 + 0.22 * shim) * pulse;
      alpha = r.alpha * flick * lum * rayIntro;
      if (alpha < 0.004) continue;
      ang = r.angle + fan + 0.014 * Math.sin(t * 0.27 + r.phase);

      /* outer soft glow of the ray */
      drawSpriteRay(r.body, ang, len, r.widthN * unit * 2.4, alpha * 0.45);
      /* main body */
      drawSpriteRay(r.body, ang, len, r.widthN * unit, alpha);
      /* bright, shimmering filament down the spine */
      if (r.hot) {
        var hotLen = len * (0.94 + 0.06 * shim2);
        drawSpriteRay(r.hot, ang, hotLen, r.widthN * unit * 0.55, alpha * 0.85);
      }
    }
  }

  function drawSpriteRay(sprite, angle, len, width, alpha) {
    if (!sprite) return;
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(angle);
    ctx.globalAlpha = alpha < 1 ? alpha : 1;
    ctx.drawImage(sprite, -width / 2, -len, width, len);
    ctx.restore();
  }

  function render(t) {
    var breath = Math.sin(t * 0.6);            /* ~10.5s breathing cycle */
    var pulse = 1 + 0.05 * breath;            /* size breathing */
    var lum = 0.86 + 0.16 * (0.5 + 0.5 * breath); /* brightness breathing */
    var micro = 1 + 0.011 * Math.sin(t * 5.1) + 0.007 * Math.sin(t * 9.7 + 1.3);

    var intro = smoothstep(0.1, 3.6, t);       /* star ignition ramp */
    var rayIntro = smoothstep(1.1, 5.0, t);    /* rays ignite slightly later */

    pointer.x += (pointer.tx - pointer.x) * 0.045;
    pointer.y += (pointer.ty - pointer.y) * 0.045;
    var pdx = -pointer.x * minSide * 0.035;
    var pdy = -pointer.y * minSide * 0.035;

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    drawField(t, pdx, pdy);
    if (rayIntro > 0.001 && !reduceMotion) drawRays(t, pulse, lum, rayIntro);
    if (intro > 0.001) drawStar(pulse, lum * intro, micro);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
  /* ---- loop / lifecycle ----------------------------------------------- */
  function loop(now) {
    if (!running) return;
    if (!startTime) startTime = now;
    var t = reduceMotion ? 9.4 : (now - startTime) / 1000;
    render(t);
    rafId = requestAnimationFrame(loop);
  }

  var resizeQueued = false;
  function onResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(function () {
      resizeQueued = false;
      /* Stars/rays are stored normalized, so only the geometry needs refreshing —
         this avoids re-randomising the whole sky on every mobile viewport jiggle. */
      measure();
      if (reduceMotion) render(9.4);
    });
  }

  function onVisibility() {
    if (reduceMotion) return;
    if (document.hidden) {
      pausedAt = performance.now();
      running = false;
      cancelAnimationFrame(rafId);
    } else if (!running) {
      if (pausedAt) startTime += performance.now() - pausedAt;
      pausedAt = 0;
      running = true;
      rafId = requestAnimationFrame(loop);
    }
  }

  function bindPointer() {
    var fine = false;
    try {
      fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    } catch (e) { fine = false; }
    if (!fine) return;
    function onMove(e) {
      pointer.tx = clamp(e.clientX / window.innerWidth - 0.5, -0.5, 0.5);
      pointer.ty = clamp(e.clientY / window.innerHeight - 0.5, -0.5, 0.5);
    }
    function onLeave() { pointer.tx = 0; pointer.ty = 0; }
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerleave', onLeave, { passive: true });
  }

  function ready() {
    buildSprites();
    measure();
    buildStars();
    buildRays();
    document.documentElement.classList.add('canvas-live');
    if (reduceMotion) {
      render(9.4);
    } else {
      running = true;
      rafId = requestAnimationFrame(loop);
    }
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(onResize).observe(canvas);
    }
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    bindPointer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})();


