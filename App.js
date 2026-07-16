// app.js - ملف التطبيق الرئيسي
import { Howl } from 'https://cdnjs.cloudflare.com/ajax/libs/howler/2.2.3/howler.min.js';

// قائمة العملات المراقبة
const SYMBOLS = [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
    'DOGEUSDT', 'SUIUSDT', 'LINKUSDT', 'AVAXUSDT', 'ADAUSDT'
];

// إعدادات WebSocket Binance
const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws';

// تخزين البيانات
let marketData = {};          // بيانات السعر الحالي
let candleData = {};         // شموع 15 دقيقة لكل عملة
let signalsHistory = [];     // سجل الإشارات
let dailySignalsCount = 0;
let winCount = 0;
let lossCount = 0;
let lastUpdateTime = null;
let notificationsEnabled = true;

// كائن الصوت
let alertSound = null;

// DOM elements
const signalsListEl = document.getElementById('signals-list');
const historyListEl = document.getElementById('history-list');
const marketOverviewEl = document.getElementById('market-overview');
const dailySignalsEl = document.getElementById('daily-signals');
const winRateEl = document.getElementById('win-rate');
const lossRateEl = document.getElementById('loss-rate');
const lastUpdateEl = document.getElementById('last-update');
const notificationToggle = document.getElementById('notification-toggle');
const installBtn = document.getElementById('install-btn');

// تهيئة الصوت
function initSound() {
    alertSound = new Howl({
        src: ['https://www.soundjay.com/misc/sounds/bell-ringing-05.mp3'],
        volume: 0.5,
        html5: true
    });
}

// --- وظائف حساب المؤشرات ---

// حساب ADX (يتطلب بيانات شموع: high, low, close)
function calculateADX(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const high = candles.map(c => c.high);
    const low = candles.map(c => c.low);
    const close = candles.map(c => c.close);

    let tr = [];
    let plusDM = [], minusDM = [];
    for (let i = 1; i < close.length; i++) {
        const h = high[i], l = low[i], prevH = high[i-1], prevL = low[i-1], prevC = close[i-1];
        const trVal = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
        tr.push(trVal);
        const upMove = h - prevH;
        const downMove = prevL - l;
        const plus = (upMove > downMove && upMove > 0) ? upMove : 0;
        const minus = (downMove > upMove && downMove > 0) ? downMove : 0;
        plusDM.push(plus);
        minusDM.push(minus);
    }

    // Smoothing (Wilder's method)
    const smooth = (arr, period) => {
        let smoothed = [];
        let first = arr.slice(0, period).reduce((a,b) => a + b, 0);
        smoothed.push(first);
        for (let i = period; i < arr.length; i++) {
            const val = smoothed[smoothed.length-1] - (smoothed[smoothed.length-1]/period) + arr[i];
            smoothed.push(val);
        }
        return smoothed;
    };

    const trSmooth = smooth(tr, period);
    const plusDMSmooth = smooth(plusDM, period);
    const minusDMSmooth = smooth(minusDM, period);

    let plusDI = [], minusDI = [], dx = [];
    for (let i = 0; i < trSmooth.length; i++) {
        const pDI = (plusDMSmooth[i] / trSmooth[i]) * 100;
        const mDI = (minusDMSmooth[i] / trSmooth[i]) * 100;
        plusDI.push(pDI);
        minusDI.push(mDI);
        const sum = pDI + mDI;
        if (sum === 0) dx.push(0);
        else dx.push(Math.abs(pDI - mDI) / sum * 100);
    }

    // ADX = smooth DX
    const adxSmooth = smooth(dx, period);
    return adxSmooth[adxSmooth.length-1];
}

// اكتشاف Order Blocks (صاعد وهابط)
// نستخدم آخر 100 شمعة (15 دقيقة) للتحليل
function findOrderBlocks(candles) {
    if (candles.length < 20) return { bullish: [], bearish: [] };
    const blocks = { bullish: [], bearish: [] };
    const len = candles.length;
    // نبحث عن الشموع التي تشكل منطقة انعكاس
    // تعريف بسيط: آخر شمعة قبل حركة قوية (كسر)
    for (let i = 5; i < len - 2; i++) {
        const c = candles[i];
        const prev = candles[i-1];
        const next = candles[i+1];
        // نتحقق من وجود كسر (break) بعد هذه الشمعة
        // للتبسيط: نستخدم شمعة i كـ Order Block إذا كانت الشموع التالية تتحرك في اتجاه واحد
        // وفي نفس الوقت الشمعة الحالية تغلق أعلى من سابقة (صاعد) أو أدنى (هابط)
        // لكن التعريف الدقيق معقد، سنستخدم طريقة مبسطة:
        // Order Block صاعد: شمعة حمراء (هابطة) ثم شمعة خضراء (صاعدة) تكسر أعلى الشمعة الحمراء
        // Order Block هابط: شمعة خضراء (صاعدة) ثم شمعة حمراء (هابطة) تكسر أدنى الشمعة الخضراء
        // نستخدم آخر 3 شموع
        if (i+2 < len) {
            const c1 = candles[i];   // الشمعة المحتملة
            const c2 = candles[i+1]; // الشمعة التالية
            const c3 = candles[i+2]; // التأكيد
            // شرط الصاعد: c1 مغلقة < مفتوحة (هابطة)، c2 مغلقة > مفتوحة (صاعدة) وتكسر أعلى c1
            // و c3 تؤكد الاتجاه (مغلقة > مفتوحة)
            if (c1.close < c1.open && c2.close > c2.open && c2.close > c1.high && c3.close > c3.open) {
                // تأكد من أن c1 ليست ضعيفة (جسم صغير)
                const body1 = Math.abs(c1.close - c1.open);
                const range1 = c1.high - c1.low;
                if (body1 / range1 > 0.3) { // تجاهل الشموع الصغيرة
                    blocks.bullish.push({
                        index: i,
                        high: c1.high,
                        low: c1.low,
                        open: c1.open,
                        close: c1.close,
                        time: c1.time
                    });
                }
            }
            // شرط الهابط: c1 مغلقة > مفتوحة (صاعدة)، c2 مغلقة < مفتوحة (هابطة) وتكسر أدنى c1
            // و c3 تؤكد الاتجاه (مغلقة < مفتوحة)
            if (c1.close > c1.open && c2.close < c2.open && c2.close < c1.low && c3.close < c3.open) {
                const body1 = Math.abs(c1.close - c1.open);
                const range1 = c1.high - c1.low;
                if (body1 / range1 > 0.3) {
                    blocks.bearish.push({
                        index: i,
                        high: c1.high,
                        low: c1.low,
                        open: c1.open,
                        close: c1.close,
                        time: c1.time
                    });
                }
            }
        }
    }
    return blocks;
}

// التحقق من إعادة الاختبار الأولى (First Retest)
// نتحقق من أن السعر عاد إلى منطقة Order Block بعد ظهورها ولم يحدث ذلك من قبل
function isFirstRetest(block, candles, currentIndex) {
    // block هو الكائن الذي يحتوي على index (موضع الشمعة) و high/low
    // نبحث عن أي شمعة بعد block.index وحتى currentIndex-1 التي تلامس المنطقة
    const blockHigh = block.high;
    const blockLow = block.low;
    // نبدأ من بعد block.index بـ 3 شموع (لتجنب التلامس المباشر)
    for (let i = block.index + 3; i < currentIndex; i++) {
        const c = candles[i];
        // إذا كان السعر قد لمس المنطقة (high > blockLow && low < blockHigh)
        if (c.high > blockLow && c.low < blockHigh) {
            // إذا كانت هذه هي المرة الأولى، نعود true
            // لكن يجب أن نتأكد أنها ليست الشمعة التي تلت مباشرة (للتأكيد)
            // نتحقق من عدم وجود تلامس قبل ذلك
            let touchedBefore = false;
            for (let j = block.index + 3; j < i; j++) {
                const cj = candles[j];
                if (cj.high > blockLow && cj.low < blockHigh) {
                    touchedBefore = true;
                    break;
                }
            }
            if (!touchedBefore) {
                return true;
            }
        }
    }
    return false;
}

// التحقق من شمعة التأكيد (إغلاق فوق المنطقة للشراء، أو أسفل للبيع)
function confirmCandle(block, candles, currentIndex, direction) {
    if (currentIndex < 1) return false;
    const lastCandle = candles[currentIndex-1]; // الشمعة الأخيرة المكتملة
    if (direction === 'buy') {
        return lastCandle.close > block.high;
    } else if (direction === 'sell') {
        return lastCandle.close < block.low;
    }
    return false;
}

// تجاهل المناطق التي بقي السعر داخلها عدة شموع (تذبذب)
function isBlockValid(block, candles) {
    // نتحقق من أن السعر لم يبقَ داخل المنطقة لأكثر من 5 شموع
    let insideCount = 0;
    for (let i = block.index + 1; i < block.index + 20; i++) {
        if (i >= candles.length) break;
        const c = candles[i];
        if (c.low < block.high && c.high > block.low) {
            insideCount++;
        }
    }
    return insideCount <= 5;
}

// إصدار الإشارة
function generateSignal(symbol, direction, entryPrice, stopLoss, takeProfit1, takeProfit2, analysis, strength, block, adx) {
    const signal = {
        symbol,
        type: direction,
        entry: entryPrice,
        stopLoss,
        takeProfit1,
        takeProfit2,
        riskReward: ((takeProfit1 - entryPrice) / (entryPrice - stopLoss)).toFixed(2),
        time: new Date().toLocaleString('ar-EG'),
        analysis,
        strength,
        block,
        adx,
        id: Date.now() + symbol
    };
    return signal;
}

// الدالة الرئيسية لتحليل كل عملة
async function analyzeSymbol(symbol) {
    const candles = candleData[symbol];
    if (!candles || candles.length < 30) return null;

    // حساب ADX
    const adx = calculateADX(candles);
    if (adx === null || adx < 25) return null; // شرط ADX

    // البحث عن Order Blocks
    const blocks = findOrderBlocks(candles);
    const lastIndex = candles.length - 1;
    const currentCandle = candles[lastIndex];

    // نتحقق من أحدث Order Block صاعد
    if (blocks.bullish.length > 0) {
        // نأخذ آخر واحد
        const block = blocks.bullish[blocks.bullish.length-1];
        // التحقق من الشروط
        if (block.index < lastIndex - 5) { // يجب أن يكون قد مضى وقت كافٍ
            // تجاهل الضعيف
            if (!isBlockValid(block, candles)) return null;
            // إعادة الاختبار الأولى
            if (!isFirstRetest(block, candles, lastIndex)) return null;
            // شمعة التأكيد
            if (!confirmCandle(block, candles, lastIndex, 'buy')) return null;
            // عدم وجود إشارة معاكسة مباشرة (نتحقق من عدم وجود Order Block هابط قريب)
            // سنتجاهل هذه النقطة للتبسيط
            // حساب وقف الخسارة والهدف
            const stopLoss = block.low - (block.high - block.low) * 0.1; // أسفل المنطقة بهامش
            const entry = currentCandle.close;
            const risk = entry - stopLoss;
            const takeProfit1 = entry + risk * 1.5;
            const takeProfit2 = entry + risk * 2.5;
            // تحديد قوة الإشارة بناءً على ADX وحجم الشمعة
            let strength = 'جيدة';
            if (adx > 30) strength = 'قوية';
            if (adx > 40) strength = 'ممتازة';
            // تحليل نصي
            const analysis = `تم اكتشاف Order Block صاعد عند سعر ${block.close.toFixed(2)}، وتمت إعادة اختباره لأول مرة، وأغلق السعر فوق المنطقة عند ${entry.toFixed(2)} مع قوة اتجاه ADX ${adx.toFixed(1)} أكبر من 25، لذلك تم إصدار إشارة شراء.`;
            return generateSignal(symbol, 'buy', entry, stopLoss, takeProfit1, takeProfit2, analysis, strength, block, adx);
        }
    }

    // نتحقق من Order Block هابط
    if (blocks.bearish.length > 0) {
        const block = blocks.bearish[blocks.bearish.length-1];
        if (block.index < lastIndex - 5) {
            if (!isBlockValid(block, candles)) return null;
            if (!isFirstRetest(block, candles, lastIndex)) return null;
            if (!confirmCandle(block, candles, lastIndex, 'sell')) return null;
            const stopLoss = block.high + (block.high - block.low) * 0.1;
            const entry = currentCandle.close;
            const risk = stopLoss - entry;
            const takeProfit1 = entry - risk * 1.5;
            const takeProfit2 = entry - risk * 2.5;
            let strength = 'جيدة';
            if (adx > 30) strength = 'قوية';
            if (adx > 40) strength = 'ممتازة';
            const analysis = `تم اكتشاف Order Block هابط عند سعر ${block.close.toFixed(2)}، وتمت إعادة اختباره لأول مرة، وأغلق السعر أسفل المنطقة عند ${entry.toFixed(2)} مع قوة اتجاه ADX ${adx.toFixed(1)} أكبر من 25، لذلك تم إصدار إشارة بيع.`;
            return generateSignal(symbol, 'sell', entry, stopLoss, takeProfit1, takeProfit2, analysis, strength, block, adx);
        }
    }
    return null;
}

// --- معالجة WebSocket ---

function connectWebSocket(symbol) {
    const stream = `${symbol.toLowerCase()}@kline_15m`;
    const ws = new WebSocket(`${BINANCE_WS_BASE}/${stream}`);
    ws.onopen = () => console.log(`WebSocket connected for ${symbol}`);
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const k = data.k;
        if (k.x) { // شمعة مكتملة
            const candle = {
                time: k.t,
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: parseFloat(k.c),
                volume: parseFloat(k.v)
            };
            // تحديث بيانات الشموع
            if (!candleData[symbol]) candleData[symbol] = [];
            candleData[symbol].push(candle);
            // الاحتفاظ بآخر 200 شمعة
            if (candleData[symbol].length > 200) {
                candleData[symbol].shift();
            }
            // تحديث السعر الحالي
            marketData[symbol] = { price: candle.close, change: 0 }; // سنحسب التغير لاحقاً
            // تحليل الإشارة
            analyzeSymbol(symbol).then(signal => {
                if (signal) {
                    addSignal(signal);
                }
            });
            updateMarketOverview();
            updateStats();
        }
    };
    ws.onerror = (e) => console.error(`WebSocket error for ${symbol}:`, e);
    ws.onclose = () => setTimeout(() => connectWebSocket(symbol), 5000);
    return ws;
}

// --- إضافة الإشارة ---

function addSignal(signal) {
    // إضافة إلى السجل
    signalsHistory.push(signal);
    // تحديث العداد اليومي
    dailySignalsCount++;
    // عرض الإشارة
    renderSignal(signal);
    // تحديث تاريخ الإشارات
    renderHistory();
    // تنبيه
    if (notificationsEnabled) {
        triggerNotification(signal);
        playAlertSound();
        vibrateDevice();
    }
    // تحديث الإحصائيات (نحتاج لتحديد الربح/الخسارة بناءً على السعر المستقبلي، لكننا لا نملك ذلك، لذا سنتركه)
    // في هذا الإصدار سنفترض أن الإشارات كلها معلقة
}

// --- عرض الإشارة ---

function renderSignal(signal) {
    const card = document.createElement('div');
    card.className = `signal-card ${signal.type === 'buy' ? 'buy' : 'sell'}`;
    const typeText = signal.type === 'buy' ? 'شراء' : 'بيع';
    const strengthClass = `strength-${signal.strength === 'ممتازة' ? 'excellent' : signal.strength === 'قوية' ? 'strong' : signal.strength === 'جيدة' ? 'good' : 'weak'}`;

    card.innerHTML = `
        <div class="signal-header">
            <span class="signal-symbol">${signal.symbol}</span>
            <span class="signal-type ${signal.type}">${typeText}</span>
        </div>
        <div class="signal-details">
            <span>الدخول: <span class="value">${signal.entry.toFixed(2)}</span></span>
            <span>وقف الخسارة: <span class="value">${signal.stopLoss.toFixed(2)}</span></span>
            <span>الهدف 1: <span class="value">${signal.takeProfit1.toFixed(2)}</span></span>
            <span>الهدف 2: <span class="value">${signal.takeProfit2.toFixed(2)}</span></span>
            <span>العائد/المخاطرة: <span class="value">${signal.riskReward}</span></span>
            <span>الوقت: <span class="value">${signal.time}</span></span>
        </div>
        <div class="signal-analysis">${signal.analysis}</div>
        <div class="signal-footer">
            <div class="signal-strength">
                <span class="strength-indicator ${strengthClass}"></span>
                <span>${signal.strength}</span>
            </div>
            <div class="signal-actions">
                <button class="share-btn" data-signal='${JSON.stringify(signal)}'>مشاركة</button>
            </div>
        </div>
    `;

    // إزالة العنصر النائب
    const placeholder = signalsListEl.querySelector('.placeholder');
    if (placeholder) placeholder.remove();

    // إدراج في الأعلى
    signalsListEl.prepend
