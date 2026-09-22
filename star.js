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
  var lastT = 0, starMark = null;
  var meteors = [], meteorTimer = 0, nextMeteorIn = 6 + Math.random() * 6;
  var burst = { flash: 0, dust: [] };
  var sparks = [], ripples = []; /* "magic sparkle" — the void answers */
  var nebulae = [];
  var starOX = 0, starOY = 0; /* on-screen star centre, for tap hit-testing */
  var tiltBound = false, tiltAsked = false;

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

    /* nebula cloud sprites: very soft colour washes (deep indigo, midnight
       purple, dark teal) — drawn at low alpha, far behind everything */
    sprites.nbIndigo = radialSprite(256, [
      [0.00, 'rgba(70,92,220,1)'],
      [0.35, 'rgba(58,76,190,0.55)'],
      [0.70, 'rgba(40,56,150,0.16)'],
      [1.00, 'rgba(30,44,120,0)']
    ]);
    sprites.nbPurple = radialSprite(256, [
      [0.00, 'rgba(138,92,224,1)'],
      [0.35, 'rgba(112,72,190,0.52)'],
      [0.70, 'rgba(82,52,146,0.15)'],
      [1.00, 'rgba(60,38,120,0)']
    ]);
    sprites.nbTeal = radialSprite(256, [
      [0.00, 'rgba(56,178,188,1)'],
      [0.35, 'rgba(46,146,156,0.5)'],
      [0.70, 'rgba(32,106,118,0.14)'],
      [1.00, 'rgba(22,80,92,0)']
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
        warm: Math.random() < 0.22,
        depth: 0.25 + Math.random() * 0.75 /* parallax + drift depth layer */
      });
    }
  }

  /* ---- nebula clouds (deepest cinematic layer) -------------------------- */
  function buildNebulae() {
    nebulae.length = 0;
    nebulae.push({ sp: sprites.nbIndigo, nx: 0.20, ny: 0.28, rN: 0.85, a: 0.085, aSpd: 0.050, aPh: 0.9, dxA: 0.045, dxS: 0.021, dyA: 0.030, dyS: 0.017 });
    nebulae.push({ sp: sprites.nbPurple, nx: 0.84, ny: 0.74, rN: 0.95, a: 0.075, aSpd: 0.043, aPh: 3.9, dxA: 0.050, dxS: 0.016, dyA: 0.035, dyS: 0.023 });
    nebulae.push({ sp: sprites.nbTeal,   nx: 0.62, ny: 0.10, rN: 0.70, a: 0.060, aSpd: 0.060, aPh: 5.6, dxA: 0.040, dxS: 0.026, dyA: 0.028, dyS: 0.019 });
  }

  function drawNebulae(t, ox, oy) {
    for (var i = 0; i < nebulae.length; i++) {
      var n = nebulae[i];
      var x = n.nx * W + Math.sin(t * n.dxS + n.aPh) * n.dxA * W + ox;
      var y = n.ny * H + Math.cos(t * n.dyS + n.aPh) * n.dyA * H + oy;
      var a = n.a * (0.72 + 0.28 * Math.sin(t * n.aSpd + n.aPh)); /* living opacity */
      var d = Math.max(W, H) * n.rN;
      ctx.globalAlpha = a;
      ctx.drawImage(n.sp, x - d / 2, y - d / 2, d, d);
    }
    ctx.globalAlpha = 1;
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
        spikeFreq: rnd2(0.5, 1.6),
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
        spikeFreq: rnd2(0.5, 1.6),
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
        spikeFreq: rnd2(0.5, 1.6),
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
    starScale = Math.min(1.9, Math.max(0.92, minSide / 720));
  }

  /* ---- drawing ---------------------------------------------------------- */
  function drawField(t, pdx, pdy) {
    var i, s, tw, a, d, x, y;
    /* very slow cosmic drift (px/s), scaled per-star by depth, wrapping at edges */
    var dx = t * 4.2;
    var dy = -t * 1.7;
    for (i = 0; i < stars.length; i++) {
      s = stars[i];
      tw = 0.5 + 0.5 * Math.sin(t * s.speed + s.phase);
      tw = tw * tw * (3 - 2 * tw); /* smooth, organic fade */
      a = s.alpha * (0.12 + 0.88 * tw);
      if (a < 0.01) continue;
      d = s.size * (5 + 3.2 * tw);
      x = s.nx * W + dx * s.depth + pdx;
      y = s.ny * H + dy * s.depth + pdy;
      x = ((x % W) + W) % W;
      y = ((y % H) + H) % H;
      ctx.globalAlpha = a < 1 ? a : 1;
      ctx.drawImage(s.warm ? sprites.warm : sprites.cool, x - d / 2, y - d / 2, d, d);
    }
  }

  function drawStar(pulse, lum, micro, ox, oy) {
    var layers = [
      [1.16, 0.12],
      [0.68, 0.20],
      [0.36, 0.30],
      [0.18, 0.44],
      [0.080, 0.66],
      [0.021, 0.96]
    ];
    for (var i = 0; i < layers.length; i++) {
      var d = minSide * layers[i][0] * pulse;
      var a = layers[i][1] * lum;
      if (a <= 0.002) continue;
      ctx.globalAlpha = a < 1 ? a : 1;
      ctx.drawImage(sprites.star, CX + ox - d / 2, CY + oy - d / 2, d, d);
    }
    /* piercing, white-hot heart */
    var cd = minSide * 0.0095 * pulse;
    ctx.globalAlpha = clamp(0.96 * lum * micro, 0, 1);
    ctx.drawImage(sprites.core, CX + ox - cd / 2, CY + oy - cd / 2, cd, cd);
  }

  function drawRays(t, pulse, lum, rayIntro, ox, oy) {
    var fan = t * 0.078; /* the whole fan turns once every ~80s */
    var i, r, shim, shim2, spike, flick, len, alpha, ang;
    for (i = 0; i < rays.length; i++) {
      r = rays[i];
      shim = 0.5 + 0.5 * Math.sin(t * r.speed + r.phase);
      shim2 = 0.5 + 0.5 * Math.sin(t * r.speed * 2.35 + r.phase * 1.7);
      /* narrow sine^14 peaks: occasional sharp sparkle, like a turning diamond */
      spike = Math.pow(Math.max(0, Math.sin(t * r.spikeFreq + r.phase * 2.3)), 14);
      flick = (0.55 + 0.45 * (shim * 0.6 + shim2 * 0.4)) * (1 + spike * 1.2);
      len = r.lenN * maxR * (0.78 + 0.22 * shim + spike * 0.16) * pulse;
      alpha = r.alpha * flick * lum * rayIntro;
      if (alpha < 0.004) continue;
      ang = r.angle + fan + 0.014 * Math.sin(t * 0.27 + r.phase);

      /* outer soft glow of the ray */
      drawSpriteRay(r.body, ang, len, r.widthN * unit * 2.4, alpha * 0.45, ox, oy);
      /* main body */
      drawSpriteRay(r.body, ang, len, r.widthN * unit, alpha, ox, oy);
      /* bright, shimmering filament down the spine */
      if (r.hot) {
        var hotLen = len * (0.94 + 0.06 * shim2 + spike * 0.05);
        drawSpriteRay(r.hot, ang, hotLen, r.widthN * unit * 0.55, alpha * 0.85, ox, oy);
      }
    }
  }

  function drawSpriteRay(sprite, angle, len, width, alpha, ox, oy) {
    if (!sprite) return;
    ctx.save();
    ctx.translate(CX + ox, CY + oy);
    ctx.rotate(angle);
    ctx.globalAlpha = alpha < 1 ? alpha : 1;
    ctx.drawImage(sprite, -width / 2, -len, width, len);
    ctx.restore();
  }

  /* ---- shooting stars -------------------------------------------------- */
  function spawnMeteor() {
    var dir = Math.random() < 0.5 ? 1 : -1;
    var ang = (18 + Math.random() * 34) * Math.PI / 180; /* shallow diagonal */
    var speed = 420 + Math.random() * 320;
    meteors.push({
      x: dir > 0 ? Math.random() * W * 0.45 : W - Math.random() * W * 0.45,
      y: -30 + Math.random() * H * 0.3,
      vx: Math.cos(ang) * speed * dir,
      vy: Math.sin(ang) * speed,
      len: 130 + Math.random() * 150,
      life: 0,
      maxLife: 0.9 + Math.random() * 0.7
    });
  }

  function updateMeteors(dt) {
    for (var i = meteors.length - 1; i >= 0; i--) {
      var m = meteors[i];
      m.life += dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      if (m.life >= m.maxLife || m.x < -320 || m.x > W + 320 || m.y > H + 320) {
        meteors.splice(i, 1);
      }
    }
  }

  function drawMeteors() {
    for (var i = 0; i < meteors.length; i++) {
      var m = meteors[i];
      var u = m.life / m.maxLife;
      var env = u < 0.12 ? u / 0.12 : Math.pow(1 - (u - 0.12) / 0.88, 1.3);
      var a = env * 0.9;
      var sp = Math.sqrt(m.vx * m.vx + m.vy * m.vy) || 1;
      var nx = m.vx / sp, ny = m.vy / sp;
      var tx = m.x - nx * m.len, ty = m.y - ny * m.len;
      var grad = ctx.createLinearGradient(m.x, m.y, tx, ty);
      grad.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(3) + ')');
      grad.addColorStop(0.3, 'rgba(214,232,255,' + (a * 0.55).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(150,190,255,0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      /* glowing head */
      var hd = 26 + 16 * env;
      ctx.globalAlpha = a * 0.5;
      ctx.drawImage(sprites.core, m.x - hd / 2, m.y - hd / 2, hd, hd);
    }
    ctx.globalAlpha = 1;
  }

  /* ---- magic touch: supernova ------------------------------------------- */
  function supernova(x, y) {
    if (reduceMotion) {
      burst.flash = 0.5; /* a gentle, single-frame bloom */
      render(9.4);
      return;
    }
    burst.flash = 1;
    var count = 60 + ((Math.random() * 41) | 0); /* 60–100 star-dust motes */
    for (var i = 0; i < count; i++) {
      var ang = Math.random() * 6.2832;
      var sp = (40 + Math.random() * 240) * (minSide / 800);
      burst.dust.push({
        x: x, y: y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        size: (1.1 + Math.random() * 2.6) * starScale,
        life: 0,
        maxLife: 1.4 + Math.random() * 1.3,
        spr: Math.random() < 0.16 ? sprites.warm : (Math.random() < 0.5 ? sprites.cool : sprites.core)
      });
    }
    if (burst.dust.length > 240) burst.dust.splice(0, burst.dust.length - 240);
    sparkleTitle();
  }

  function updateBurst(dt) {
    for (var i = burst.dust.length - 1; i >= 0; i--) {
      var d = burst.dust[i];
      d.life += dt;
      if (d.life >= d.maxLife) { burst.dust.splice(i, 1); continue; }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.vx *= Math.exp(-dt * 0.7); /* silky deceleration */
      d.vy *= Math.exp(-dt * 0.7);
    }
  }

  function drawBurst() {
    for (var i = 0; i < burst.dust.length; i++) {
      var d = burst.dust[i];
      var u = d.life / d.maxLife;
      var a = Math.pow(1 - u, 1.4) * 0.85;
      var s = d.size * (6 + 5 * (1 - u)); /* glow shrinks as the mote fades */
      ctx.globalAlpha = a;
      ctx.drawImage(d.spr, d.x - s / 2, d.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  function sparkleTitle() {
    if (!starMark) starMark = document.querySelector('.star-mark');
    if (!starMark) return;
    var inner = starMark.querySelector('.star-name__inner');
    if (!inner) return;
    inner.classList.remove('is-shimmer');
    void inner.offsetWidth; /* force the one-shot animation to restart */
    inner.classList.add('is-shimmer');
  }

  /* ---- magic sparkle: the void answers a touch ------------------------- */
  function sparkleAt(x, y) {
    if (reduceMotion) { ripples.push({ x: x, y: y, life: 0, maxLife: 0.7 }); return; }
    var count = 10 + ((Math.random() * 6) | 0); /* 10–15 airy motes */
    for (var i = 0; i < count; i++) {
      var ang = Math.random() * 6.2832;
      var sp = (12 + Math.random() * 66) * (minSide / 800);
      sparks.push({
        x: x, y: y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 6, /* a whisper of lift, like real dust */
        size: (0.7 + Math.random() * 1.5) * starScale,
        life: 0,
        maxLife: 0.55 + Math.random() * 0.6,
        spr: Math.random() < 0.28 ? sprites.core : sprites.cool
      });
    }
    ripples.push({ x: x, y: y, life: 0, maxLife: 0.7 + Math.random() * 0.25 });
    /* pooled: keep the worst-case cost fixed no matter how many taps land */
    if (sparks.length > 120) sparks.splice(0, sparks.length - 120);
    if (ripples.length > 12) ripples.splice(0, ripples.length - 12);
  }

  function updateSparks(dt) {
    for (var i = sparks.length - 1; i >= 0; i--) {
      var s = sparks[i];
      s.life += dt;
      if (s.life >= s.maxLife) { sparks.splice(i, 1); continue; }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= Math.exp(-dt * 1.1); /* airy drag: quick bloom, slow settle */
      s.vy *= Math.exp(-dt * 1.1);
    }
  }

  function drawSparks() {
    for (var i = 0; i < sparks.length; i++) {
      var s = sparks[i];
      var u = s.life / s.maxLife;
      var a = Math.pow(1 - u, 1.6) * 0.6; /* subtle and airy */
      var d = s.size * (5 + 4 * (1 - u));
      ctx.globalAlpha = a;
      ctx.drawImage(s.spr, s.x - d / 2, s.y - d / 2, d, d);
    }
    ctx.globalAlpha = 1;
  }

  function updateRipples(dt) {
    for (var i = ripples.length - 1; i >= 0; i--) {
      ripples[i].life += dt;
      if (ripples[i].life >= ripples[i].maxLife) ripples.splice(i, 1);
    }
  }

  function drawRipples() {
    for (var i = 0; i < ripples.length; i++) {
      var rp = ripples[i];
      var u = rp.life / rp.maxLife;
      var a = Math.pow(1 - u, 1.8) * 0.5;
      var r = minSide * (0.012 + 0.075 * (1 - Math.pow(1 - u, 2))); /* fast out, slow finish */
      /* soft inner light */
      var d = r * 1.3;
      ctx.globalAlpha = a * 0.4;
      ctx.drawImage(sprites.core, rp.x - d / 2, rp.y - d / 2, d, d);
      /* thin expanding ring */
      ctx.globalAlpha = a;
      ctx.strokeStyle = rgba('214,230,255', a);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, r, 0, 6.2832);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* ---- pointer / tilt parallax for the title --------------------------- */
  function updateTextParallax(x, y) {
    if (!starMark) starMark = document.querySelector('.star-mark');
    if (!starMark) return;
    /* hard cap: extreme tilts shift the word, never off the glass */
    var lim = minSide * 0.06;
    var px = clamp(x, -lim, lim), py = clamp(y, -lim, lim);
    starMark.style.setProperty('--par-x', px.toFixed(1) + 'px');
    starMark.style.setProperty('--par-y', py.toFixed(1) + 'px');
  }

  function render(t) {
    var dt = t - lastT;
    lastT = t;
    if (dt <= 0 || dt > 0.1) dt = 0.016; /* guard against tab jumps */

    var breath = Math.sin(t * 0.6);            /* ~10.5s breathing cycle */
    var pulse = 1 + 0.05 * breath;            /* size breathing */
    var lum = 0.86 + 0.16 * (0.5 + 0.5 * breath); /* brightness breathing */
    var micro = 1 + 0.011 * Math.sin(t * 5.1) + 0.007 * Math.sin(t * 9.7 + 1.3);

    var intro = smoothstep(0.1, 3.6, t);       /* star ignition ramp */
    var rayIntro = smoothstep(1.1, 5.0, t);    /* rays ignite slightly later */

    pointer.x += (pointer.tx - pointer.x) * 0.055; /* LERP: smooth, no jitter */
    pointer.y += (pointer.ty - pointer.y) * 0.055;
    if (Math.abs(pointer.tx - pointer.x) < 0.0005) pointer.x = pointer.tx; /* settle */
    if (Math.abs(pointer.ty - pointer.y) < 0.0005) pointer.y = pointer.ty;

    /* depth contrast: nebulae almost static (infinite distance) → star + title
       travel the most, so they float visibly above the glass */
    var ndx = -pointer.x * minSide * 0.008;
    var ndy = -pointer.y * minSide * 0.008;
    var pdx = -pointer.x * minSide * 0.016;
    var pdy = -pointer.y * minSide * 0.016;
    var sdx = -pointer.x * minSide * 0.075;
    var sdy = -pointer.y * minSide * 0.075;
    /* extreme tilts must never slide the star off-screen */
    sdx = clamp(sdx, -minSide * 0.05, minSide * 0.05);
    sdy = clamp(sdy, -minSide * 0.05, minSide * 0.05);

    /* supernova decay: rapid rise, silky ~0.9s fall */
    if (burst.flash > 0) {
      burst.flash *= Math.exp(-dt * 3.1);
      if (burst.flash < 0.004) burst.flash = 0;
    }
    var flash = burst.flash;
    var fScale = 1 + flash * 0.45;
    var fLum = 1 + flash * 1.7;

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';

    /* nebula clouds: the deepest layer, breathing slowly */
    drawNebulae(t, ndx, ndy);
    drawField(t, pdx, pdy);

    if (!reduceMotion) {
      updateTextParallax(-pointer.x * minSide * 0.045, -pointer.y * minSide * 0.045);

      /* a shooting star every 10–20s (first one a little sooner) */
      meteorTimer += dt;
      if (meteorTimer >= nextMeteorIn) {
        meteorTimer = 0;
        nextMeteorIn = 10 + Math.random() * 10;
        if (intro > 0.5) spawnMeteor();
      }
      updateMeteors(dt);
      drawMeteors();
      updateBurst(dt);
      updateSparks(dt);
      updateRipples(dt);
    }

    starOX = CX + sdx;
    starOY = CY + sdy;
    if (rayIntro > 0.001 && !reduceMotion) drawRays(t, pulse, lum * fLum, rayIntro, sdx, sdy);
    if (intro > 0.001) drawStar(pulse * fScale, lum * intro * fLum, micro * (1 + flash * 0.6), sdx, sdy);
    drawBurst();
    drawSparks();
    drawRipples();
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

  /* Pointer parallax: mouse, pen and touch-drag all feed the same channel.
     Touch springs back to centre on release (touch-action: none streams moves). */
  function bindPointer() {
    function onMove(e) {
      pointer.tx = clamp(e.clientX / window.innerWidth - 0.5, -0.5, 0.5);
      pointer.ty = clamp(e.clientY / window.innerHeight - 0.5, -0.5, 0.5);
    }
    function onEnd(e) {
      if (e.pointerType === 'touch') { pointer.tx = 0; pointer.ty = 0; }
    }
    function onLeave() { pointer.tx = 0; pointer.ty = 0; }
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerleave', onLeave, { passive: true });
    window.addEventListener('pointerup', onEnd, { passive: true });
    window.addEventListener('pointercancel', onEnd, { passive: true });
  }

  /* Device tilt feeds the same parallax channel as the pointer. */
  function bindTilt() {
    if (tiltBound) return;
    tiltBound = true;
    window.addEventListener('deviceorientation', function (e) {
      if (e.gamma == null || e.beta == null) return;
      var g = e.gamma, b = e.beta, a = 0;
      try {
        if (window.orientation != null) a = Math.abs(window.orientation);
        else if (window.screen.orientation && window.screen.orientation.angle != null) a = window.screen.orientation.angle;
      } catch (e2) { a = 0; }
      if (a === 90 || a === 270) { var tmp = g; g = b; b = -tmp; } /* landscape axes */
      pointer.tx = clamp(g / 32, -1, 1) * 0.95;
      pointer.ty = clamp((b - 45) / 32, -1, 1) * 0.95;
    }, { passive: true });
  }

  /* iOS 13+: DeviceOrientationEvent.requestPermission() must run inside a
     user gesture — the first star tap doubles as that gesture. */
  function requestTilt() {
    if (tiltAsked) return;
    tiltAsked = true;
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
          .then(function (state) { if (state === 'granted') bindTilt(); })
          .catch(function () { /* denied: touch parallax stays */ });
      }
      /* other platforms: bindTilt() was already bound in ready() */
    } catch (e) { /* gyroscope unavailable: touch parallax stays */ }
  }

  /* ---- magic touch input ------------------------------------------------
     One global listener: near the star → supernova, anywhere else → an airy
     sparkle cluster + light ripple at the exact finger position. */
  function hitStar(x, y) {
    var dx = x - starOX, dy = y - starOY;
    var r = minSide * 0.16;
    return dx * dx + dy * dy <= r * r;
  }

  function onSceneTouch(e) {
    var touches = (e.changedTouches && e.changedTouches.length) ? e.changedTouches : [e];
    var starHit = false;
    for (var i = 0; i < touches.length; i++) {
      var t = touches[i];
      if (hitStar(t.clientX, t.clientY)) {
        starHit = true;
        supernova(starOX, starOY);
      } else {
        sparkleAt(t.clientX, t.clientY);
      }
    }
    if (starHit) {
      if (e.cancelable) e.preventDefault(); /* no bounce, no double-tap zoom */
      requestTilt(); /* iOS: first star tap doubles as the permission gesture */
    }
  }

  function bindTouch() {
    /* global: the whole glass answers the finger */
    document.addEventListener('touchstart', onSceneTouch, { passive: false });
    document.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') return; /* touchstart covers it */
      onSceneTouch(e);
    });
    /* iOS pinch/zoom guard while interacting with the scene */
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
  }

  function ready() {
    buildSprites();
    measure();
    buildStars();
    buildRays();
    buildNebulae();
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
    bindTilt();
    bindTouch();
    /* retire the one-shot title shimmer when it finishes */
    document.addEventListener('animationend', function (e) {
      if (e.animationName === 'titleSparkle' && starMark) {
        var inner = starMark.querySelector('.star-name__inner');
        if (inner) inner.classList.remove('is-shimmer');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})();


