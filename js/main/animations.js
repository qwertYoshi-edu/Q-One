import { screens, confettiCanvas } from './dom.js';

export const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : null;
}

export function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, v = max;
    let d = max - min;
    s = max == 0 ? 0 : d / max;
    if (max == min) h = 0;
    else {
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return { h: h * 360, s, v };
}

export function hsvToRgb(h, s, v) {
    let r, g, b;
    let i = Math.floor(h / 60) % 6;
    let f = h / 60 - i;
    let p = v * (1 - s);
    let q = v * (1 - f * s);
    let t = v * (1 - (1 - f) * s);
    switch (i) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        case 5: r = v, g = p, b = q; break;
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

export function triggerMeterAnimation(targetPercentage, visualEl, percentageEl, startColorHex, endColorHex) {
    visualEl.style.setProperty('--percentage', 0);
    percentageEl.textContent = '0%';
    const startRgb = hexToRgb(startColorHex);
    const endRgb = hexToRgb(endColorHex);
    if (!startRgb || !endRgb) return;
    const startHsv = rgbToHsv(startRgb.r, startRgb.g, startRgb.b);
    const endHsv = rgbToHsv(endRgb.r, endRgb.g, endRgb.b);
    const duration = 1200;
    let startTime = null;

    function animationStep(timestamp) {
        if (!startTime) startTime = timestamp;
        const elapsedTime = timestamp - startTime;
        const progress = Math.min(elapsedTime / duration, 1);
        const easedProgress = easeInOutCubic(progress);
        const displayPercentage = targetPercentage * easedProgress;
        const h = startHsv.h + easedProgress * (endHsv.h - startHsv.h);
        const s = startHsv.s + easedProgress * (endHsv.s - startHsv.s);
        const v = startHsv.v + easedProgress * (endHsv.v - startHsv.v);
        const interpolatedRgb = hsvToRgb(h, s, v);
        const interpolatedColor = `rgb(${interpolatedRgb.r}, ${interpolatedRgb.g}, ${interpolatedRgb.b})`;
        visualEl.style.setProperty('--percentage', displayPercentage);
        visualEl.style.setProperty('--progress-color', interpolatedColor);
        percentageEl.textContent = `${Math.floor(displayPercentage)}%`;
        percentageEl.style.color = interpolatedColor;
        if (progress < 1) requestAnimationFrame(animationStep);
    }
    requestAnimationFrame(animationStep);
}

export function triggerPerfectAnimation() {
    const endScreen = screens.end;
    if (!endScreen) {
        console.warn('[Q-One:DOM] 終了画面がないため完了アニメーションを省略します。');
        return;
    }
    const visualEl = endScreen.querySelector('.results-visual');
    const percentageEl = endScreen.querySelector('#end-percentage');
    if (!visualEl || !percentageEl) {
        console.warn('[Q-One:DOM] 完了アニメーション用要素が不足しています。');
        return;
    }
    endScreen.classList.remove('is-animating');
    percentageEl.textContent = '0%';
    visualEl.style.setProperty('--percentage', 0);

    setTimeout(() => {
        endScreen.classList.add('is-animating');
        const duration = 1200, targetPercentage = 100;
        let startTime = null;

        function animationStep(timestamp) {
            if (!startTime) startTime = timestamp;
            const elapsedTime = timestamp - startTime;
            const progress = Math.min(elapsedTime / duration, 1);
            const easedProgress = easeInOutCubic(progress);
            const displayPercentage = targetPercentage * easedProgress;
            visualEl.style.setProperty('--percentage', displayPercentage);
            percentageEl.textContent = `${Math.floor(displayPercentage)}%`;
            if (progress < 1) requestAnimationFrame(animationStep);
            else triggerConfetti();
        }
        requestAnimationFrame(animationStep);
    }, 350);
}

export function triggerConfetti() {
    if (!confettiCanvas) return;
    const ctx = confettiCanvas.getContext('2d');
    if (!ctx) return;
    const W = window.innerWidth, H = window.innerHeight;
    confettiCanvas.width = W;
    confettiCanvas.height = H;
    const particles = [];
    const particleCount = 150;
    const colors = ['#34D399', '#FBBF24', '#EF4444', '#60A5FA', '#A78BFA'];
    for (let i = 0; i < particleCount; i++) {
        particles.push({
            x: Math.random() * W,
            y: Math.random() * H - H,
            w: Math.random() * 10 + 5,
            h: Math.random() * 10 + 5,
            vx: (Math.random() - 0.5) * 10,
            vy: Math.random() * 5 + 2,
            angle: Math.random() * 360,
            color: colors[Math.floor(Math.random() * colors.length)]
        });
    }
    let animationFrameId;

    function draw() {
        ctx.clearRect(0, 0, W, H);
        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle * Math.PI / 180);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
            p.y += p.vy;
            p.x += p.vx;
            p.angle += p.vx / 2;
            if (p.y > H + 20) {
                particles.splice(i, 1);
                i--;
            }
        }
        if (particles.length > 0) animationFrameId = requestAnimationFrame(draw);
        else {
            ctx.clearRect(0, 0, W, H);
            cancelAnimationFrame(animationFrameId);
        }
    }
    draw();
}
