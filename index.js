const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver'); 
const { BOT_TOKEN, API_KEY, API_BASE, API_DEPOSIT, LINK_CHANNEL, LINK_BUY, CHANNEL_ID, FEE_PERCENT, LOG_CHANNEL, ADMIN_ID, ZAKKI_TOKEN, FEE_DEPOSIT_PERCENT } = require('./config');

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ================= SETUP DATABASE =================
const dbPath = path.join(__dirname, 'database', 'users.json');
function bacaDatabase() {
  try { return JSON.parse(fs.readFileSync(dbPath, 'utf8')); } 
  catch (err) { return []; }
}
function simpanDatabase(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

// ================= HELPER SETTINGS DINAMIS =================
const dbSettingsPath = path.join(__dirname, 'database', 'settings.json');
function bacaSettings() {
  try { return JSON.parse(fs.readFileSync(dbSettingsPath, 'utf8')); } 
  catch (e) { return { DEPO_V1_ACTIVE: true, DEPO_V2_ACTIVE: false }; }
}
function simpanSettings(data) {
  fs.writeFileSync(dbSettingsPath, JSON.stringify(data, null, 2));
}


// ==================================================

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' }
});

const apiDeposit = axios.create({
  baseURL: API_DEPOSIT || 'https://warungnokos.web.id/api/deposit',
  headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' }
});

const userSessions = {};

async function safeEdit(chatId, messageId, text, keyboard, parseMode = 'HTML') {
  try {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: messageId, parse_mode: parseMode, reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    if (err.message.includes('no text in the message') || err.message.includes('message is not modified')) {
      if (err.message.includes('no text in the message')) {
        await bot.deleteMessage(chatId, messageId).catch(() => {});
        await bot.sendMessage(chatId, text, { parse_mode: parseMode, reply_markup: { inline_keyboard: keyboard } });
      }
    } else {
      console.error('[SAFE EDIT ERROR]', err.message);
    }
  }
}


// Variabel penyimpan data layanan sementara di RAM agar tidak delay
let cachedServices = [];
let lastFetchServices = 0;

// Tambahkan parameter forceRefresh = false untuk mendukung tombol "Perbarui"
async function getServices(forceRefresh = false) {
  const now = Date.now();
  
  // Jika BUKAN perintah refresh dan cache di RAM belum lewat 10 menit, langsung kembalikan dari RAM
  if (!forceRefresh && cachedServices.length > 0 && (now - lastFetchServices) < 600000) {
    return cachedServices;
  }

  try { 
    const { data } = await api.get('/services'); 
    if (data.success && Array.isArray(data.data)) {
      cachedServices = data.data;
      lastFetchServices = now;
      return cachedServices;
    }
    return cachedServices; // Kembalikan cache lama jika API pusat sedang gangguan
  } catch (e) { 
    return cachedServices; 
  }
}

// Variabel cache sementara di RAM untuk Negara & Produk
let cachedCountries = [];
let lastFetchCountries = 0;
const cachedProducts = {}; // Menyimpan cache berdasarkan serviceId

async function getCountries() {
  const now = Date.now();
  if (cachedCountries.length > 0 && (now - lastFetchCountries) < 600000) {
    return cachedCountries;
  }
  try { 
    const { data } = await api.get('/countries'); 
    if (data.success && Array.isArray(data.data)) {
      cachedCountries = data.data;
      lastFetchCountries = now;
      return cachedCountries;
    }
    return cachedCountries;
  } catch (e) { 
    return cachedCountries; 
  }
}

// Tambahkan parameter forceRefresh = false untuk mendukung tombol "Perbarui"
async function getProducts(platformId, countryId, forceRefresh = false) {
  const cacheKey = `${platformId}_${countryId || 'all'}`;
  const now = Date.now();

  if (!forceRefresh && cachedProducts[cacheKey] && (now - cachedProducts[cacheKey].time) < 180000) {
    return cachedProducts[cacheKey].data;
  }

  try { 
    const { data } = await api.get(`/products?platform_id=${platformId}&country_id=${countryId}`); 
    if (data.success && Array.isArray(data.data)) {
      cachedProducts[cacheKey] = { data: data.data, time: now };
      return data.data;
    }
    return cachedProducts[cacheKey]?.data || [];
  } catch (e) { 
    return cachedProducts[cacheKey]?.data || []; 
  }
}

// ================= API KOMUNIKASI WARUNGNOKOS =================
// Tambahkan parameter retry = 1 agar bot otomatis mencoba 1 kali lagi jika koneksi diputus
async function createDeposit(nominal, retry = 1) {
  try {
    const { API_KEY, API_DEPOSIT } = require('./config');
    
    // Request ke API WarungNokos
    const response = await axios({
      method: 'POST',
      url: API_DEPOSIT + '/create', // Pastikan endpoint sesuai dengan config kamu
      headers: { 
        'x-api-key': API_KEY, 
        'Content-Type': 'application/json' 
      },
      data: {
        "amount": nominal
      },
      timeout: 10000 // Batas waktu tunggu maksimal 10 detik agar tidak hang
    });
    
    return response.data;
    
  } catch (e) {
    // JIKA TERJADI ECONNRESET, COBA ULANG OTOMATIS
    if (e.code === 'ECONNRESET' && retry > 0) {
        console.log(`[NETWORK] Terjadi ECONNRESET saat deposit. Mencoba ulang... (Sisa percobaan: ${retry})`);
        // Jeda waktu (delay) 1 detik sebelum mencoba lagi agar server pusat bernapas
        await new Promise(resolve => setTimeout(resolve, 1000));
        return await createDeposit(nominal, retry - 1);
    }

    // Tangkap pesan eror agar lebih rapi untuk dibaca user
    let errorMsg = e.message;
    if (e.code === 'ECONNRESET') {
        errorMsg = "Koneksi jaringan ke server pusat terputus. Silakan coba lagi.";
    }

    return { 
        success: false, 
        message: e.response?.data?.message || errorMsg 
    };
  }
}

async function checkDepositStatus(trxId) {
  try { const { data } = await apiDeposit.get(`/status/${trxId}`); return data; } catch (e) { return { success: false, status: 'error' }; }
}
async function cancelDeposit(trxId) {
  try { const { data } = await apiDeposit.post('/cancel', { trxId }); return data; } catch (e) { return { success: false }; }
}
// 1. Fungsi Order OTP Baru
async function createOrder(productId, appId, countryId, serviceName) {
  try { 
    const { data } = await api.post('/order', { 
      product_id: productId, 
      app_id: appId, 
      country_id: countryId, 
      service_name: serviceName 
    }); 
    return data; 
  } catch (e) { 
    return { success: false, message: e.response?.data?.message || e.message }; 
  }
}

// 2. Fungsi Cek Status OTP (Menggunakan trxId dari pusat)
async function checkOrderStatus(trxId) {
  try { 
    // Endpoint: /api/smscode/status/:trxId
    const { data } = await api.get(`/status/${trxId}`); 
    return data; 
  } catch (e) { 
    return { success: false, status: 'error' }; 
  }
}

// 3. Fungsi Batalkan Order (Mengirim body { trxId } sesuai dokumentasi)
async function cancelOrder(trxId) {
  try { 
    // Endpoint: /api/smscode/cancel dengan body { trxId }
    const { data } = await api.post('/cancel', { trxId }); 
    return data; 
  } catch (e) { 
    return { success: false, message: e.response?.data?.message || e.message }; 
  }
}


 // Fungsi untuk membuat string acak 11 karakter seperti signature SMS
function generateRandomSmsHash() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';
  let result = '';
  for (let i = 0; i < 11; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}


    // Fungsi untuk mengirim notifikasi sukses ke Channel dengan privasi
function kirimLogSuksesOTP(trxData, otpCode) {
  const { LINK_BUY, CS_URL, LOG_CHANNEL } = require('./config');

  // Format Waktu: "08 Nov 2026 • 18:28 WIB"
  const d = new Date(trxData.waktu);
  const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const pad = (n) => n < 10 ? '0'+n : n;
  const waktuTrx = `${pad(d.getDate())} ${bulan[d.getMonth()]} ${d.getFullYear()} • ${pad(d.getHours())}:${pad(d.getMinutes())} WIB`;
  
  // Proses penyensoran data
  const rawUsername = trxData.username ? trxData.username : String(trxData.user_id);
  const usernameDisensor = sensorUsername(rawUsername);
  const nomorDisensor = sensorNomor(trxData.nomor);

  // Format kode OTP agar memiliki tanda hubung di tengah jika 6 digit (contoh: 458243 -> 458-243)
  const otpStr = String(otpCode);
  const otpFormatted = otpStr.length === 6 ? `${otpStr.slice(0,3)}-${otpStr.slice(3)}` : otpStr;
  
  const randomHash = generateRandomSmsHash();

  // PERBAIKAN: Gunakan &lt; dan &gt; agar Telegram tidak mengiranya sebagai tag HTML
  const textLog = `<b>OTP ORDER RECEIVED V1!!</b> 🔐\n\n` +
                  `Users: ${usernameDisensor}\n` +
                  `ID: ${trxData.id_trx}\n` +
                  `Layanan: ${trxData.layanan}\n` +
                  `Nomor: <code>${nomorDisensor}</code>\n` +
                  `SMS code: <code>${otpCode}</code>\n` +
                  `Harga: Rp ${formatRp(trxData.harga)}\n` +
                  `Tanggal: ${waktuTrx}\n\n` +
                  `<pre>&lt;#&gt; Kode ${trxData.layanan}: ${otpFormatted}\n` +
                  `Jangan bagikan kode ini dengan orang lain\n` +
                  `${randomHash}</pre>`;

  // Tombol disusun tanpa style tambahan (menggunakan style bawaan/transparan)
  const keyboardLog = [
    [
      { text: `Copy OTP`, copy_text: { text: otpStr } }
    ],
    [
      { text: `Ke Bot`, url: LINK_BUY },
      { text: `Hubungi Owner`, url: CS_URL }
    ]
  ];

  // Kirim ke channel log
  bot.sendMessage(LOG_CHANNEL, textLog, { 
      parse_mode: 'HTML', 
      reply_markup: { inline_keyboard: keyboardLog } 
  }).catch(err => console.error("Gagal kirim log OTP:", err.message));
}

   

// Fungsi untuk menyensor username (misal: june7829 -> jun***29)
function sensorUsername(username) {
  if (!username) return 'TanpaUsername';
  const str = String(username);
  if (str.length <= 5) return str.substring(0, 2) + '***'; // Jika username terlalu pendek
  return str.substring(0, 3) + '***' + str.substring(str.length - 2);
}

// Fungsi untuk menyensor nomor HP (misal: 082144441890 -> 0821****1890)
function sensorNomor(nomor) {
  if (!nomor) return '***';
  const str = String(nomor);
  if (str.length <= 8) return str.substring(0, 2) + '****' + str.substring(str.length - 2);
  return str.substring(0, 4) + '****' + str.substring(str.length - 4);
}



// ================= HELPER RENDER TAMPILAN PESANAN (BULK & PAGINATION) =================
function renderOrderView(trxIds, pageIndex) {
  const dbTrx = bacaTrx();
  const totalOrders = trxIds.length;
  const safeIndex = Math.max(0, Math.min(pageIndex, totalOrders - 1));
  const currentTrxId = trxIds[safeIndex];
  const trxData = dbTrx.find(t => t.id_trx === currentTrxId);

  if (!trxData) {
    return { text: 'Data pesanan tidak ditemukan.', keyboard: [[{ text: 'Menu utama', callback_data: 'menu' }]] };
  }

  const headerPagination = `Total Pesanan: ${safeIndex + 1}/${totalOrders}\n\n`;
  let bodyText = '';
  const keyboard = [];

  // Membuat baris tombol navigasi pagination sesuai posisi halaman
  const navRow = [];
  if (totalOrders > 1) {
    if (safeIndex === 0) {
      // Halaman 1 dari N
      navRow.push({ text: 'Pesanan Selanjutnya ›', callback_data: `ord_page|${safeIndex + 1}` });
    } else if (safeIndex === totalOrders - 1) {
      // Halaman terakhir
      navRow.push({ text: '‹ Pesanan Sebelumnya', callback_data: `ord_page|${safeIndex - 1}` });
    } else {
      // Halaman di tengah
      navRow.push({ text: '‹ Sebelumnya', callback_data: `ord_page|${safeIndex - 1}` });
      navRow.push({ text: 'Berikutnya ›', callback_data: `ord_page|${safeIndex + 1}` });
    }
  }

  // STATE 1: MENUNGGU OTP (PESANAN BERHASIL)
  if (trxData.status === 'waiting' || trxData.status === 'pending') {
    bodyText = `✅ <b>PESANAN BERHASIL</b>\n\n` +
               `📦 Layanan: ${trxData.layanan}\n` +
               `📞 Nomor: <code>${trxData.nomor}</code>\n` +
               `💵 Harga: Rp ${formatRp(trxData.harga)}\n` +
               `🆔 TRX: <code>${trxData.id_trx}</code>\n\n` +
               `Segera daftar pakai nomor di atas. Bot sedang mengecek OTP secara otomatis...`;

    keyboard.push([{ text: 'Salin Nomor', copy_text: { text: String(trxData.nomor) } }]);
    keyboard.push([
      { text: 'Cek Status', callback_data: `cek_otp|${trxData.id_trx}|${safeIndex}` },
      { text: 'Batalkan Pesanan', callback_data: `cancel|${trxData.id_trx}|${safeIndex}`, style: 'danger' }
    ]);
    if (navRow.length > 0) keyboard.push(navRow);
    keyboard.push([{ text: 'Menu utama', callback_data: 'menu' }]);
  }
  // STATE 2: PESANAN BATAL
  else if (trxData.status === 'canceled' || trxData.status === 'cancelled' || trxData.status === 'expired') {
    bodyText = `❌ <b>PESANAN BATAL</b>\n\n` +
               `📦 Layanan: ${trxData.layanan}\n` +
               `📞 Nomor: <code>${trxData.nomor}</code>\n` +
               `💵 Harga: Rp ${formatRp(trxData.harga)}\n` +
               `🆔 TRX: <code>${trxData.id_trx}</code>\n\n` +
               `Pesanan dibatalkan karena nomor tidak mendapatkan OTP dalam waktu yang ditentukan. Saldo telah dikembalikan.`;

    if (navRow.length > 0) keyboard.push(navRow);
    keyboard.push([
      { text: '‹ Kembali ke Menu Service', callback_data: 'menu_services' },
      { text: 'Menu utama', callback_data: 'menu' }
    ]);
  }
  // STATE 3: OTP BERHASIL
  else if (trxData.status === 'completed') {
    bodyText = `✅ <b>OTP BERHASIL</b>\n\n` +
               `📦 Layanan: ${trxData.layanan}\n` +
               `📞 Nomor: <code>${trxData.nomor}</code>\n` +
               `🔑 OTP: <code>${trxData.otp}</code>\n` +
               `🆔 TRX: <code>${trxData.id_trx}</code>\n\n` +
               `Silahkan masukkan kode OTP di atas untuk menyelesaikan verifikasi.`;

    if (navRow.length > 0) keyboard.push(navRow);
    keyboard.push([{ text: 'Salin OTP', copy_text: { text: String(trxData.otp) } }]);
    keyboard.push([
      { text: '‹ Kembali ke Menu Service', callback_data: 'menu_services' },
      { text: 'Menu utama', callback_data: 'menu' }
    ]);
  }

  return { text: headerPagination + bodyText, keyboard };
}



// ================= HELPERS & SETUP DATABASE TRX =================
const dbTrxPath = path.join(__dirname, 'database', 'transaksi_users.json');
function bacaTrx() {
  try { return JSON.parse(fs.readFileSync(dbTrxPath, 'utf8')); } catch (e) { return []; }
}
function simpanTrx(data) {
  fs.writeFileSync(dbTrxPath, JSON.stringify(data, null, 2));
}
function generateTrxId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 10; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}
function formatRp(angka) { return Number(angka).toLocaleString('id-ID'); }
function bersihkanEmoji(teks) { return teks.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim(); }
function chunkArray(array, size) {
  const chunked = [];
  for (let i = 0; i < array.length; i += size) chunked.push(array.slice(i, i + size));
  return chunked;
}

// ================= HELPER DEPOSIT & LOG =================
const dbDepoPath = path.join(__dirname, 'database', 'deposit_users.json');
function bacaDeposit() {
  try { return JSON.parse(fs.readFileSync(dbDepoPath, 'utf8')); } 
  catch (e) { return []; }
}
function simpanDeposit(data) {
  fs.writeFileSync(dbDepoPath, JSON.stringify(data, null, 2));
}


 function kirimLogDeposit(depoData, rawUsername) {
  const usernameDisensor = sensorUsername(rawUsername);
  
  // PERBAIKAN 1: Gunakan 'created_at' bukan 'waktu'
  const waktuDepo = new Date(depoData.created_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  
  const textLog = `<blockquote>` +
                  `┌ 💳 <b>DEPOSIT SUKSES</b>\n` +
                  `├ 👤 Pembeli : @${usernameDisensor}\n` +
                  `├ 🆔 TRX : <code>${depoData.id_trx}</code>\n` +
                  `├ 💰 Nominal : Rp ${formatRp(depoData.amount)}\n` +
                  // PERBAIKAN 2: Gunakan 'final_price' bukan 'total'
                  `├ 💵 Total Bayar : Rp ${formatRp(depoData.final_price)}\n` + 
                  `└ ⏰ Waktu : ${waktuDepo}\n\n` +
                  `💙 Saldo telah otomatis ditambahkan.` +
                  `</blockquote>`;

  bot.sendMessage(require('./config').LOG_CHANNEL, textLog, { parse_mode: 'HTML' })
     .catch(err => console.error("Gagal kirim log depo:", err.message));
}

  
    

    

// ================= EKSEKUTOR DEPOSIT V1 (WARUNGNOKOS) =================
async function prosesDepositV1(chatId, userId, nominal, hapusPesanId, username) {
  const feeNominal = (nominal * (FEE_DEPOSIT_PERCENT / 100));
  const finalPrice = Math.ceil(nominal + feeNominal); // Nominal + Persen

  const waitMsg = await bot.sendMessage(chatId, "⏳ <i>Menyiapkan QRIS Deposit V1...</i>", { parse_mode: 'HTML' });
  const res = await createDeposit(finalPrice);
  
  if (!res.success) {
    return bot.editMessageText(`<blockquote>❌ <b>Gagal:</b> ${res.message || 'Sistem sibuk.'}</blockquote>`, { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'HTML' });
  }

  // Waktu Kedaluwarsa 5 Menit
  const timeNow = new Date();
  const timeExpired = new Date(timeNow.getTime() + 5 * 60000);
  const timeExpString = timeExpired.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });

  const myTrx = generateTrxId();

  let dbDepo = bacaDeposit();
  dbDepo.push({
    id_trx: myTrx,
    provider_trx: res.trxId,
    userId: userId,
    username: username || String(userId),
    amount: nominal,
    fee_persen: FEE_DEPOSIT_PERCENT,
    final_price: res.total,
    metode: 'V1',
    status: 'pending',
    created_at: timeNow.toISOString(),
    expired_at: timeExpired.toISOString()
  });
  simpanDeposit(dbDepo);

  const textQR = `<blockquote>` +
                 `┌ 💳 <b>INVOICE DEPOSIT V1</b>\n` +
                 `├ 🆔 TRX : <code>${myTrx}</code>\n` +
                 `├ 💰 Nominal Deposit : Rp ${formatRp(nominal)}\n` +
                 `└ 💵 <b>Total Bayar : Rp ${formatRp(res.total)}</b>\n\n` +
                 `┌ 📌 <b>PETUNJUK</b>\n` +
                 `├ Expired dalam 5 menit (pukul ${timeExpString} WIB).\n` +
                 `├ Cancel manual terbuka setelah 1 menit.\n` +
                 `└ Klik Cek Status setelah bayar sesuai TOTAL.\n\n` +
                 `💙 Menunggu pembayaran...` +
                 `</blockquote>`;

  const keyboardQR = [
    [
      { text: 'Batalkan', callback_data: `batal_depo|${myTrx}`, style: 'primary' },
      { text: 'Cek Status', callback_data: `cek_depo|${myTrx}`, style: 'primary' }
    ]
  ];

  const qrBuffer = Buffer.from(res.qr_image.split(',')[1], 'base64');
  if (hapusPesanId) await bot.deleteMessage(chatId, hapusPesanId).catch(() => {});
  await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
  
  bot.sendPhoto(chatId, qrBuffer, { caption: textQR, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardQR } });
}

// ================= EKSEKUTOR DEPOSIT V2 (ZAKKI) =================
async function prosesDepositV2(chatId, userId, nominal, hapusPesanId, username) {
  const { FEE_DEPOSIT_PERCENT } = require('./config');
  const feeNominal = (nominal * (FEE_DEPOSIT_PERCENT / 100));
  const finalPrice = Math.ceil(nominal + feeNominal);

  const waitMsg = await bot.sendMessage(chatId, "⏳ <i>Menyiapkan QRIS Deposit V2...</i>", { parse_mode: 'HTML' });
  const res = await createDepositV2(finalPrice);
  
  if (!res.success) {
    return bot.editMessageText(`<blockquote>❌ <b>Gagal:</b> ${res.message || 'Sistem sibuk.'}</blockquote>`, { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'HTML' });
  }

  const timeNow = new Date();
  const timeExpired = new Date(timeNow.getTime() + 5 * 60000); // 5 Menit
  const timeExpString = timeExpired.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });

  const myTrx = generateTrxId();

  let dbDepo = bacaDeposit();
  dbDepo.push({
    id_trx: myTrx,
    provider_trx: res.data.id_transaksi, // API Zakki menggunakan id_transaksi
    userId: userId,
    username: username || String(userId),
    amount: nominal,
    fee_persen: FEE_DEPOSIT_PERCENT,
    final_price: res.data.rincian.total_bayar,
    metode: 'V2',
    status: 'pending',
    created_at: timeNow.toISOString(),
    expired_at: timeExpired.toISOString()
  });
  simpanDeposit(dbDepo);

  const textQR = `<blockquote>` +
                 `┌ 💳 <b>INVOICE DEPOSIT V2</b>\n` +
                 `├ 🆔 TRX : <code>${myTrx}</code>\n` +
                 `├ 💰 Nominal Deposit : Rp ${formatRp(nominal)}\n` +
                 `└ 💵 <b>Total Bayar : Rp ${formatRp(res.data.rincian.total_bayar)}</b>\n\n` +
                 `┌ 📌 <b>PETUNJUK</b>\n` +
                 `├ Expired dalam 5 menit (pukul ${timeExpString} WIB).\n` +
                 `├ Cancel manual terbuka setelah 1 menit.\n` +
                 `└ Klik Cek Status setelah bayar sesuai TOTAL.\n\n` +
                 `💙 Menunggu pembayaran...` +
                 `</blockquote>`;

  const keyboardQR = [
    [
      { text: 'Batalkan', callback_data: `batal_depo|${myTrx}`, style: 'primary' },
      { text: 'Cek Status', callback_data: `cek_depo|${myTrx}`, style: 'primary' }
    ]
  ];

  // API Zakki memberikan image berupa URL
  if (hapusPesanId) await bot.deleteMessage(chatId, hapusPesanId).catch(() => {});
  await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
  
  bot.sendPhoto(chatId, res.data.qris_image, { caption: textQR, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardQR } });
}

  
    
  

// ================= API DEPOSIT V2 (ZAKKI) =================
async function createDepositV2(nominal) {
  try {
    const response = await axios.post('https://qris.zpr0.com/topupv2', {
      token: ZAKKI_TOKEN,
      nominal: Number(nominal)
    });
    if (response.data.code === 201) return { success: true, data: response.data.data };
    return { success: false, message: response.data.message };
  } catch (e) {
    return { success: false, message: e.response?.data?.message || e.message };
  }
}

async function checkDepositStatusV2(providerTrx) {
  try {
    const response = await axios.get(`https://qris.zpr0.com/cektopup?idtopup=${providerTrx}`);
    if (response.data.code === 200 && response.data.data.status === 'SUCCESS') {
      return { success: true, status: 'success' };
    }
    return { success: false, status: 'pending' };
  } catch (e) {
    return { success: false, status: 'pending' };
  }
}

async function cancelDepositV2(providerTrx) {
  try {
    const response = await axios.get(`https://qris.zpr0.com/cancel?token=${ZAKKI_TOKEN}&id_transaksi=${providerTrx}`);
    return { success: response.data.code === 200, message: response.data.message };
  } catch (e) {
    return { success: false, message: e.response?.data?.message || e.message };
  }
}

function formatWaktuRiwayat(isoString) {
  const d = new Date(isoString);
  const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const pad = (n) => n < 10 ? '0'+n : n;
  return `${pad(d.getDate())} ${bulan[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())} WIB`;
}


// ================================================================

 
async function showMainMenu(chatId, userId, username, namaUser = 'Kak') {
  // 1. Ambil data dari semua database
  const dbUsers = bacaDatabase();
  const dbTrx = bacaTrx();
  const dbDepo = bacaDeposit();

  // 2. Ambil saldo user saat ini
  const userData = dbUsers.find(u => String(u.id) === String(userId)) || { saldo: 0 };
  const saldoSaatIni = userData.saldo;

  // 3. Kalkulasi Total Order OTP (Hanya yang statusnya 'completed')
  const userTrx = dbTrx.filter(t => String(t.user_id) === String(userId) && t.status === 'completed');
  const totalTransaksi = userTrx.length;
  const totalBelanja = userTrx.reduce((acc, curr) => acc + curr.harga, 0);

  // 4. Kalkulasi Total Deposit (Hanya yang statusnya 'success')
  const userDepo = dbDepo.filter(d => (String(d.userId) === String(userId) || String(d.user_id) === String(userId)) && d.status === 'success');
  const totalDeposit = userDepo.reduce((acc, curr) => acc + curr.amount, 0);

  // 5. Penyesuaian tampilan Username & Nama (Aman dari karakter khusus/underscore)
  const safeNamaUser = typeof escapeHtml === 'function' ? escapeHtml(namaUser) : namaUser;
  const displayUsername = username ? `@${username}` : 'Tidak Ada';

  const bannerPath = path.join(__dirname, 'foto.jpg');
  
  // Gunakan format HTML agar karakter garis bawah (_) pada username tidak bikin error
  const text = `✨ <b>ᴀᴜᴛᴏ ᴏʀᴅᴇʀ ᴏᴛᴘ ᴘʀᴇᴍɪᴜᴍ</b> ✨\n` +
               `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
               `Halo <b>${safeNamaUser}</b>! 👋\n` +
               `Kamu bisa order nomor virtual (Nokos) otomatis buat verifikasi WhatsApp, Telegram, dll. Pembayaran via QRIS (Otomatis 24 Jam).\n\n` +
               `📊 <b>I N F O  A K U N</b>\n` +
               `👤 Username : ${displayUsername}\n` +
               `🆔 ID Akun : <code>${userId}</code>\n` +
               `💰 Saldo : Rp ${formatRp(saldoSaatIni)}\n` +
               `📥 Total Deposit : Rp ${formatRp(totalDeposit)}\n` +
               `🛒 Total Belanja : Rp ${formatRp(totalBelanja)} (${totalTransaksi} TRX)\n\n` +
               `📌 <b>ꜱɪʟᴀᴋᴀɴ ᴘɪʟɪʜ ᴍᴇɴᴜ ᴅɪ ʙᴀᴡᴀʜ:</b>`;

  const keyboard = [
    [{ text: 'ᴏʀᴅᴇʀ ɴᴏᴋᴏꜱ ꜱᴇᴋᴀʀᴀɴɢ', callback_data: 'menu_services', style: 'primary' }],
    [{ text: 'ɪꜱɪ ꜱᴀʟᴅᴏ', callback_data: 'menu_deposit', style: 'primary' }],
    [{ text: 'ʀɪᴡᴀʏᴀᴛ ᴛʀᴀɴꜱᴀᴋꜱɪ', callback_data: 'menu_history', style: 'primary' }],
    [
      { text: 'ᴊᴏɪɴ ᴄʜᴀɴɴᴇʟ', url: LINK_CHANNEL },
      { text: 'ʙᴜʏ ꜱᴄʀɪᴘᴛ', url: LINK_BUY }
    ]
  ];

  try {
    const imageBuffer = fs.readFileSync(bannerPath);
    await bot.sendPhoto(chatId, imageBuffer, { 
      caption: text, 
      parse_mode: 'HTML', 
      reply_markup: { inline_keyboard: keyboard } 
    });
  } catch (err) {
    console.error('[MENU ERROR] Gagal load foto.jpg:', err.message);
    await bot.sendMessage(chatId, text, { 
      parse_mode: 'HTML', 
      reply_markup: { inline_keyboard: keyboard } 
    }).catch(e => console.error('[MENU TEXT ERROR]', e.message));
  }
}
          
             

// ================= LOGIKA START & FORCE JOIN =================
bot.onText(/^\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || '';
  const namaUser = msg.from.first_name || 'Kak';
  
  console.log(`[DEBUG START] Pesan /start diterima dari ID: ${userId} | Nama: ${namaUser}`);

  try {
    let dbUsers = bacaDatabase();
    let isUserExist = dbUsers.find(u => String(u.id) === String(userId));

    if (isUserExist) {
      console.log(`[DEBUG START] User ${userId} sudah terdaftar. Membuka Menu Utama...`);
      if (isUserExist.username !== username) {
        isUserExist.username = username;
        simpanDatabase(dbUsers);
      }
      await showMainMenu(chatId, userId, username, namaUser);
    } else {
      console.log(`[DEBUG START] User ${userId} belum terdaftar. Mengecek status channel (${CHANNEL_ID})...`);
      
      // Jika CHANNEL_ID belum diatur (masih '-' atau kosong), langsung daftarkan user tanpa Force Join
      if (!CHANNEL_ID || CHANNEL_ID === '-' || CHANNEL_ID.trim() === '') {
        console.log(`[DEBUG START] CHANNEL_ID kosong, melewati Force Join...`);
        const waktuDaftar = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        dbUsers.push({ id: userId, nama: namaUser, username: username, saldo: 0, terdaftarPada: waktuDaftar });
        simpanDatabase(dbUsers);
        return await showMainMenu(chatId, userId, username, namaUser);
      }

      try {
        const chatMember = await bot.getChatMember(CHANNEL_ID, userId);
        console.log(`[DEBUG START] Status member di channel: ${chatMember.status}`);
        
        if (['member', 'administrator', 'creator'].includes(chatMember.status)) {
          const waktuDaftar = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
          dbUsers.push({ id: userId, nama: namaUser, username: username, saldo: 0, terdaftarPada: waktuDaftar });
          simpanDatabase(dbUsers);
          await showMainMenu(chatId, userId, username, namaUser);
        } else {
          await tampilkanPesanWajibJoin(chatId, namaUser);
        }
      } catch (errChannel) {
        console.error(`[DEBUG START ERROR] Gagal cek channel:`, errChannel.message);
        await tampilkanPesanWajibJoin(chatId, namaUser);
      }
    }
  } catch (errGlobal) {
    console.error(`[FATAL START ERROR]`, errGlobal.message);
  }
});

// Fungsi membersihkan karakter HTML agar nama user yang aneh tidak bikin error
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function tampilkanPesanWajibJoin(chatId, namaUser) {
  const safeName = escapeHtml(namaUser);
  const pesan = `⚠️ <b>Akses Ditolak</b>\n\n` +
                `Halo <b>${safeName}</b>, kamu belum terdaftar di database kami.\n` +
                `Untuk menggunakan bot ini, kamu wajib bergabung ke channel resmi kami terlebih dahulu.`;
                
  const keyboard = [
    [{ text: "📢 Join Channel Sekarang", url: LINK_CHANNEL }],
    [{ text: "✅ Saya sudah join", callback_data: `cek_join|${safeName.substring(0, 20)}` }]
  ];

  try {
    await bot.sendMessage(chatId, pesan, { 
      parse_mode: 'HTML', 
      reply_markup: { inline_keyboard: keyboard } 
    });
    console.log(`[DEBUG START] Pesan Wajib Join berhasil dikirim ke ${chatId}`);
  } catch (err) {
    console.error(`[ERROR KIRIM WAJIB JOIN] Gagal mengirim pesan ke ${chatId}:`, err.message);
  }
}



// ================= FITUR ADMIN MENU =================
bot.onText(/\/adminmenu/, async (msg) => {
  const chatId = msg.chat.id;
  const { ADMIN_ID } = require('./config');

  // Keamanan: Pastikan hanya Admin yang bisa akses
  if (chatId.toString() !== ADMIN_ID.toString()) {
    return bot.sendMessage(chatId, "❌ Akses Ditolak. Menu ini khusus Administrator.");
  }

  tampilkanMenuAdmin(chatId);
});

async function tampilkanMenuAdmin(chatId) {
  const bannerPath = path.join(__dirname, 'foto.jpg'); 
  const text = `_PANEL ADMINISTRATOR_\n\n` +
               `Selamat datang di Pusat Kontrol Bot.\n` +
               `Kelola fitur, integrasi, dan data pengguna di sini.\n\n` +
               `Gunakan dengan bijak.`;
               
  const keyboard = [
    [{ text: 'List User', callback_data: 'admin_users|1', style: 'primary' }], // Tombol Baru
    [{ text: 'Settings Deposit', callback_data: 'admin_depo_settings', style: 'primary' }],
    [{ text: 'Backup Script', callback_data: 'admin_backup', style: 'primary' }] 
  ];

  try {
    const imageBuffer = fs.readFileSync(bannerPath);
    await bot.sendPhoto(chatId, imageBuffer, { caption: text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  } catch (err) {
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  }
}



// =======================================================


// ================= CALLBACK QUERY =================
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const senderName = query.from.first_name || 'Kak';
  const data = query.data;

  try {
    let dbUsers = bacaDatabase();
    let user = dbUsers.find(u => u.id === userId);
    const saldoSaatIni = user ? (user.saldo || 0) : 0;

    if (data === 'menu') {
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, messageId).catch(() => {});
      delete userSessions[userId];
      // Contoh di dalam bot.on('callback_query', ...)
showMainMenu(chatId, userId, query.from.username, query.from.first_name);
      return;
    }

            if (data.startsWith('cek_join|')) {
      const namaUser = data.split('|')[1];
      const username = query.from.username || '';
      bot.answerCallbackQuery(query.id, { text: 'Mengecek status channel...' });
      
      try {
        const chatMember = await bot.getChatMember(CHANNEL_ID, userId);
        
        if (chatMember.status === 'member' || chatMember.status === 'administrator' || chatMember.status === 'creator') {
          const waktuDaftar = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
          
          dbUsers.push({ id: userId, nama: namaUser, username: username, saldo: 0, terdaftarPada: waktuDaftar });
          simpanDatabase(dbUsers);
          
          await bot.deleteMessage(chatId, messageId).catch(() => {});
          // PERBAIKAN: Kirim 4 parameter lengkap ke showMainMenu
          showMainMenu(chatId, userId, username, namaUser);

          // --- NOTIFIKASI KE CHANNEL LOG ---
          const textLog = `<blockquote>` +
                          `┌ 👤 <b>PENGGUNA BARU</b>\n` +
                          `├ 📛 Username : ${username ? '@' + username : 'Tidak ada username'}\n` +
                          `├ 🆔 ID User : <code>${userId}</code>\n` +
                          `└ ⏰ Waktu : ${waktuDaftar}\n\n` +
                          `💙 Pengguna berhasil melewati Force Join.` +
                          `</blockquote>`;
          const btnLog = [
            [{ text: 'Cek Profile User', callback_data: `cek_user|${userId}`, style: 'primary' }]
          ];
          
          bot.sendMessage(LOG_CHANNEL, textLog, { parse_mode: 'HTML', reply_markup: { inline_keyboard: btnLog } }).catch(err => console.error("Gagal kirim log:", err.message));
          
        } else {
          bot.answerCallbackQuery(query.id, { text: "❌ Tolak: Kamu belum bergabung ke channel!", show_alert: true });
        }
      } catch (err) {
        bot.answerCallbackQuery(query.id, { text: "❌ Gagal mengecek channel. Pastikan bot sudah menjadi Admin di channel!", show_alert: true });
      }
      return;
    }


    // --- FITUR CEK PROFILE (Dari tombol di Channel) ---
    if (data.startsWith('cek_user|')) {
      const targetUserId = data.split('|')[1];
      let cekDbUsers = bacaDatabase();
      let targetUser = cekDbUsers.find(u => u.id === parseInt(targetUserId));
      
      if (targetUser) {
          bot.answerCallbackQuery(query.id, { 
              text: `👤 INFO PROFILE\nNama: ${targetUser.nama}\nSaldo: Rp ${formatRp(targetUser.saldo)}\nDaftar: ${targetUser.terdaftarPada}`, 
              show_alert: true 
          });
      } else {
          bot.answerCallbackQuery(query.id, { text: "Pengguna tidak ditemukan di database.", show_alert: true });
      }
      return;
    }


       // ================= 1. DAFTAR USER (ADMIN) =================
    if (data.startsWith('admin_users|')) {
      const page = parseInt(data.split('|')[1]) || 1;
      bot.answerCallbackQuery(query.id);

      const dbUsers = bacaDatabase();
      const dbTrx = bacaTrx();
      const dbDepo = bacaDeposit();

      // Kalkulasi Global
      let totalSaldoGlobal = 0;
      let totalDepositGlobal = dbDepo.filter(d => d.status === 'success').reduce((acc, curr) => acc + curr.amount, 0);
      let totalBelanjaGlobal = dbTrx.filter(t => t.status === 'completed').reduce((acc, curr) => acc + curr.harga, 0);
      const totalUser = dbUsers.length;

      // Hitung total belanja masing-masing user untuk sistem peringkat (Leaderboard)
      let usersWithStats = dbUsers.map(u => {
          totalSaldoGlobal += u.saldo || 0;
          let belanjaUser = dbTrx.filter(t => t.user_id === u.id && t.status === 'completed').reduce((acc, curr) => acc + curr.harga, 0);
          return { ...u, belanjaUser };
      });

      // Urutkan user berdasarkan belanja terbanyak (Peringkat 1 di atas)
      usersWithStats.sort((a, b) => b.belanjaUser - a.belanjaUser);

      // Pagination
      const limit = 6;
      const totalPages = Math.ceil(totalUser / limit) || 1;
      const offset = (page - 1) * limit;
      const currentUsers = usersWithStats.slice(offset, offset + limit);

      const text = `_Daftar User_\n\n` +
                   `Total Deposit Semua User: Rp ${formatRp(totalDepositGlobal)}\n` +
                   `Total Belanja Semua User: Rp ${formatRp(totalBelanjaGlobal)}\n` +
                   `Total Saldo Semua User: Rp ${formatRp(totalSaldoGlobal)}\n` +
                   `Total User Terdaftar: ${totalUser} User\n` +
                   `Total Halaman: ${totalPages}\n\n` +
                   `Silahkan pilih user yang ingin kamu lihat atau edit.\n` +
                   `Kamu bisa mengubah saldo, status, dan data user dari menu detail.\n\n` +
                   `Gunakan tombol di bawah untuk mencari user atau kembali ke menu admin.`;

      const keyboard = [];

      // Render 6 Button User ke bawah
      currentUsers.forEach((u, index) => {
          const rank = offset + index + 1; // Peringkat global
          let btnStyle = '';
          
          if (rank === 1) btnStyle = 'success';
          else if (rank === 2) btnStyle = 'primary';
          else if (rank === 3) btnStyle = 'danger';

          const btnName = u.username ? `@${u.username}` : (u.nama || String(u.id));
          const textTombol = `${rank}. ${btnName} - Rp ${formatRp(u.belanjaUser)}`;
          
          let btnObj = { text: textTombol, callback_data: `admin_user_detail|${u.id}|${page}` };
          if (btnStyle) btnObj.style = btnStyle; // Hanya tambahkan style jika masuk top 3
          
          keyboard.push([btnObj]);
      });

      // Baris Navigasi Halaman
      const navRow = [];
      if (page > 1) navRow.push({ text: 'Sebelumnya', callback_data: `admin_users|${page - 1}` });
      if (page < totalPages) navRow.push({ text: 'Selanjutnya', callback_data: `admin_users|${page + 1}` });
      if (navRow.length > 0) keyboard.push(navRow);

      keyboard.push([
          { text: 'Refresh', callback_data: `admin_users|${page}`, style: 'primary' },
          { text: 'Menu Admin', callback_data: 'admin_menu' }
      ]);

      // Karena menu admin pakai foto, kita harus hapus fotonya dulu saat beralih ke teks
      if (query.message.photo) {
          await bot.deleteMessage(chatId, messageId).catch(() => {});
          bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
      } else {
          safeEdit(chatId, messageId, text, keyboard, 'Markdown');
      }
      return;
    }

    // ================= 2. DETAIL USER (ADMIN) =================
    if (data.startsWith('admin_user_detail|')) {
      const [, targetId, page] = data.split('|');
      bot.answerCallbackQuery(query.id);

      const dbUsers = bacaDatabase();
      const targetUser = dbUsers.find(u => String(u.id) === String(targetId));
      if (!targetUser) return bot.answerCallbackQuery(query.id, { text: 'User tidak ditemukan.', show_alert: true });

      const dbTrx = bacaTrx();
      const dbDepo = bacaDeposit();

      const userOtp = dbTrx.filter(t => String(t.user_id) === String(targetId));
      const userDepo = dbDepo.filter(d => String(d.userId) === String(targetId) || String(d.user_id) === String(targetId));

      const totalBelanjaUser = userOtp.filter(t => t.status === 'completed').reduce((a, c) => a + c.harga, 0);
      const totalDepositUser = userDepo.filter(d => d.status === 'success').reduce((a, c) => a + c.amount, 0);
      const totalOrder = userOtp.length;

      const dispUsername = targetUser.username ? `@${targetUser.username}` : '-';
      const dispNama = targetUser.nama || '-';

      const text = `_Detail User_\n\n` +
                   `Nama: ${dispNama}\n` +
                   `ID User: ${targetId}\n` +
                   `Username: ${dispUsername}\n\n` +
                   `Saldo: Rp ${formatRp(targetUser.saldo)}\n` +
                   `Total Deposit: Rp ${formatRp(totalDepositUser)}\n` +
                   `Total Belanja: Rp ${formatRp(totalBelanjaUser)}\n` +
                   `Total Order OTP: ${totalOrder} Order\n\n` +
                   `Status: Aktif\n` +
                   `Terdaftar Pada: Data Lama\n` +
                   `Terakhir Aktif: Baru saja\n\n` +
                   `---\n\n` +
                   `Pilih aksi di bawah untuk mengelola user ini.\n` +
                   `Kamu bisa edit saldo, blokir user, atau reset data user.`;

      const keyboard = [
          [{ text: 'Tambah/Kurangi Saldo User', callback_data: `admin_edit_saldo|${targetId}|${page}`, style: 'primary' }],
          [{ text: 'Lihat Semua Transaksi', callback_data: `admin_user_trx|${targetId}|1`, style: 'primary' }],
          [
              { text: 'Kembali', callback_data: `admin_users|${page}` },
              { text: 'Menu Admin', callback_data: 'admin_menu' }
          ]
      ];

      safeEdit(chatId, messageId, text, keyboard, 'Markdown');
      return;
    }



        // ================= 3. PEMICU EDIT SALDO (FORCE REPLY) =================
    if (data.startsWith('admin_edit_saldo|')) {
      const [, targetId, page] = data.split('|');
      bot.answerCallbackQuery(query.id);
      
      await bot.deleteMessage(chatId, messageId).catch(() => {});
      
      const textEdit = `_Edit Saldo User_\n\n` +
                       `Ketik nominal yang ingin ditambahkan (gunakan +) atau dikurangi (gunakan -).\n\n` +
                       `Contoh Tambah: +10000\n` +
                       `Contoh Kurang: -5000\n\n` +
                       `ID Target: ${targetId}`;

      bot.sendMessage(chatId, textEdit, { parse_mode: 'Markdown', reply_markup: { force_reply: true, selective: true } });
      
      // Simpan session target agar penangkap pesan tahu siapa yang diedit
      userSessions[userId] = { action: 'edit_saldo', targetId: targetId, page: page };
      return;
    }



             // ================= 4. SEMUA TRANSAKSI USER (GABUNGAN) =================
    if (data.startsWith('admin_user_trx|')) {
      const [, targetId, pageStr] = data.split('|');
      const page = parseInt(pageStr) || 1;
      bot.answerCallbackQuery(query.id);

      const dbTrx = bacaTrx();
      const dbDepo = bacaDeposit();

      // Ambil dan standarisasi data agar bisa digabung
      let userOtp = dbTrx.filter(t => String(t.user_id) === String(targetId)).map(t => ({...t, _type: 'otp', _date: t.waktu}));
      let userDepo = dbDepo.filter(d => String(d.userId) === String(targetId) || String(d.user_id) === String(targetId)).map(d => ({...d, _type: 'deposit', _date: (d.created_at || d.waktu)}));
      
      // Gabungkan dan urutkan dari yang terbaru (awal) ke lama
      let allTrx = [...userDepo, ...userOtp].sort((a, b) => new Date(b._date) - new Date(a._date));

      const totalTransaksi = allTrx.length;
      const totalBelanja = userOtp.filter(t => t.status === 'completed').reduce((a, c) => a + c.harga, 0);
      const totalDeposit = userDepo.filter(d => d.status === 'success').reduce((a, c) => a + c.amount, 0);

      // Pagination
      const limit = 6;
      const totalPages = Math.ceil(totalTransaksi / limit) || 1;
      const offset = (page - 1) * limit;
      const currentItems = allTrx.slice(offset, offset + limit);

      const dbUsers = bacaDatabase();
      const targetUser = dbUsers.find(u => String(u.id) === String(targetId));
      const dispNama = targetUser ? targetUser.nama : '-';

      // Perbarui teks sesuai dengan format yang diminta
      const text = `_Semua Transaksi User_\n\n` +
                   `Nama: ${dispNama}\n` +
                   `ID User: ${targetId}\n\n` +
                   `Total Transaksi: ${totalTransaksi} Transaksi\n` +
                   `Total Belanja: Rp ${formatRp(totalBelanja)}\n` +
                   `Total Deposit: Rp ${formatRp(totalDeposit)}\n\n` +
                   `Silahkan pilih transaksi di bawah untuk melihat detail lengkapnya.\n` +
                   `Setiap transaksi menampilkan jenis, status, dan nominalnya secara real-time.`;

      const keyboard = [];

      currentItems.forEach(item => {
          if (item._type === 'deposit') {
              // Terjemahkan status deposit ke label yang diminta
              let labelStatus = 'pending';
              if (item.status === 'success') labelStatus = 'sukses';
              else if (item.status === 'canceled' || item.status === 'expired') labelStatus = 'batal';

              let btnText = `deposit • ${labelStatus} • ${formatRp(item.amount)}`;
              // Hapus parameter style agar kembali ke tombol biasa
              keyboard.push([{ text: btnText, callback_data: `admin_cekdepo|${item.id_trx}|${targetId}|${page}` }]);
          } else {
              // Terjemahkan status order OTP ke label yang diminta
              let labelStatus = 'pending';
              if (item.status === 'completed' || item.status === 'success') labelStatus = 'sukses';
              else if (item.status === 'canceled' || item.status === 'cancelled' || item.status === 'expired') labelStatus = 'batal';
              
              const nomor4Digit = item.nomor ? String(item.nomor).slice(-4) : 'xxxx';
              const namaLayanan = item.layanan.substring(0, 10);
              let btnText = `orderotp • ${labelStatus} • ${namaLayanan} | ${nomor4Digit}`;
              
              // Hapus parameter style agar kembali ke tombol biasa
              keyboard.push([{ text: btnText, callback_data: `admin_cekotp|${item.id_trx}|${targetId}|${page}` }]); 
          }
      });

      // Navigasi
      const navRow = [];
      if (page > 1) navRow.push({ text: 'Sebelumnya', callback_data: `admin_user_trx|${targetId}|${page - 1}` });
      if (page < totalPages) navRow.push({ text: 'Selanjutnya', callback_data: `admin_user_trx|${targetId}|${page + 1}` });
      if (navRow.length > 0) keyboard.push(navRow);

      keyboard.push([{ text: 'Kembali', callback_data: `admin_user_detail|${targetId}|1` }]);

      safeEdit(chatId, messageId, text, keyboard, 'Markdown');
      return;
    }



       // ================= 5. DETAIL DEPOSIT (ADMIN) =================
    if (data.startsWith('admin_cekdepo|')) {
      const [, trxId, targetId, page] = data.split('|');
      bot.answerCallbackQuery(query.id);

      const dbDepo = bacaDeposit();
      const depo = dbDepo.find(d => d.id_trx === trxId);
      if (!depo) return bot.answerCallbackQuery(query.id, { text: 'Data tidak ditemukan.', show_alert: true });

      const dbUsers = bacaDatabase();
      const targetUser = dbUsers.find(u => String(u.id) === String(targetId));
      const dispNama = targetUser ? targetUser.nama : '-';
      
      const waktuReq = new Date(depo.created_at || depo.waktu).toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'});
      let text = '';
      let keyboard = [];

      if (depo.status === 'success') {
          text = `_Detail Transaksi Deposit - Succes_\n\nID Transaksi: ${depo.id_trx}\nJenis: Deposit / Top Up Saldo\n\nNama: ${dispNama}\nID User: ${targetId}\n\nJumlah Deposit: Rp ${formatRp(depo.amount)}\nMetode Pembayaran: QRIS\nStatus: Sukses\n\nWaktu Request: ${waktuReq} WIB\nWaktu Selesai: ${waktuReq} WIB\n\nSaldo Sebelum: Rp ${formatRp(targetUser.saldo - depo.amount)}\nSaldo Sesudah: Rp ${formatRp(targetUser.saldo)}`;
          
          keyboard.push([{ text: 'Kembali', callback_data: `admin_user_trx|${targetId}|${page}` }]);
      } 
      else if (depo.status === 'pending' || depo.status === 'waiting') {
          text = `_Detail Transaksi Deposit - Pending_\n\nID Transaksi: ${depo.id_trx}\nJenis: Deposit / Top Up Saldo\n\nNama: ${dispNama}\nID User: ${targetId}\n\nJumlah Deposit: Rp ${formatRp(depo.amount)}\nMetode Pembayaran: QRIS\nStatus: Menunggu Pembayaran\n\nWaktu Request: ${waktuReq} WIB\nBatas Pembayaran: 5 Menit dari request\n\nSaldo Sebelum: Rp ${formatRp(targetUser.saldo)}\nSaldo Sesudah: Belum ditambahkan`;

          keyboard = [
              [
                  { text: 'Kirim Pengingat ke User', callback_data: `admin_remind_depo|${trxId}|${targetId}` },
                  { text: 'Kembali', callback_data: `admin_user_trx|${targetId}|${page}` }
              ]
          ];
      } 
      else {
          text = `_Detail Transaksi Deposit - Dibatalkan_\n\nID Transaksi: ${depo.id_trx}\nJenis: Deposit / Top Up Saldo\n\nNama: CS WARUNG-NOKOS\nID User: ${targetId}\n\nJumlah Deposit: Rp ${formatRp(depo.amount)}\nMetode Pembayaran: QRIS\nStatus: Dibatalkan\n\nWaktu Request: ${waktuReq} WIB\nWaktu Dibatalkan: ${waktuReq} WIB\nAlasan: Dibatalkan oleh user / Melewati batas pembayaran\n\nSaldo tidak ditambahkan karena transaksi dibatalkan.`;
          
          keyboard.push([{ text: 'Kembali', callback_data: `admin_user_trx|${targetId}|${page}` }]);
      }

      safeEdit(chatId, messageId, text, keyboard, 'Markdown');
      return;
    }

    // ================= 6. KIRIM PENGINGAT PENDING KE USER =================
    if (data.startsWith('admin_remind_depo|')) {
      const [, trxId, targetId] = data.split('|');
      
      const dbDepo = bacaDeposit();
      const depo = dbDepo.find(d => d.id_trx === trxId);
      if (!depo || depo.status !== 'pending') return bot.answerCallbackQuery(query.id, { text: 'Transaksi tidak pending.', show_alert: true });

      const dbUsers = bacaDatabase();
      const targetUser = dbUsers.find(u => String(u.id) === String(targetId));
      
      const pesanUser = `_Deposit Masih Pending_\n\nHalo ${targetUser ? targetUser.nama : 'Kak'},\nDeposit kamu sebesar Rp ${formatRp(depo.amount)} masih menunggu pembayaran.\n\nID Transaksi: ${trxId}\nMetode: QRIS\nBatas Pembayaran: 5 Menit\n\nSilahkan selesaikan pembayaran sekarang, atau batalkan deposit jika tidak jadi melakukan pembayaran.`;
      
      // Tombol ini MENGGUNAKAN FUNGSI LAMA milik user, sehingga sangat efisien!
      const keyboardUser = [
          [
              { text: 'Cek Status Deposit', callback_data: `cek_depo|${trxId}`, style: 'primary' },
              { text: 'Batalkan', callback_data: `batal_depo|${trxId}`, style: 'danger' }
          ]
      ];

      bot.sendMessage(targetId, pesanUser, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboardUser } })
         .then(() => {
             bot.answerCallbackQuery(query.id, { text: '✅ Pesan pengingat berhasil dikirim ke user!', show_alert: true });
         })
         .catch(() => {
             bot.answerCallbackQuery(query.id, { text: '❌ Gagal mengirim pesan. Bot mungkin diblokir user.', show_alert: true });
         });
      return;
    }



      
          // ================= FITUR BACKUP SCRIPT (TOMBOL) =================
    if (data === 'admin_backup') {
      const { ADMIN_ID } = require('./config');
      
      // Keamanan ganda: Pastikan yang klik tombol benar-benar Admin
      if (chatId.toString() !== ADMIN_ID.toString()) {
          return bot.answerCallbackQuery(query.id, { text: "❌ Maaf, tombol ini khusus Admin.", show_alert: true });
      }

      // Hilangkan animasi loading pada tombol
      bot.answerCallbackQuery(query.id); 

      // Kirim pesan tunggu
      const waitMsg = await bot.sendMessage(chatId, "⏳ *Sedang membuat file backup...*", { parse_mode: 'Markdown' });
      
      // Proses kompresi file zip
      const output = fs.createWriteStream(path.join(__dirname, 'backup_script.zip'));
      const archive = archiver('zip', { zlib: { level: 9 } }); // Level kompresi maksimal

      output.on('close', async () => {
          await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
          
          // Kirim file zip ke chat Admin
          await bot.sendDocument(chatId, path.join(__dirname, 'backup_script.zip'), { 
              caption: "✅ *Backup Selesai!*\nFolder `node_modules` telah dikecualikan agar file ringan.", 
              parse_mode: 'Markdown' 
          });
          
          // Hapus file zip dari memori server agar tidak menumpuk
          fs.unlinkSync(path.join(__dirname, 'backup_script.zip')); 
      });

      archive.on('error', (err) => {
          console.error(err);
          bot.sendMessage(chatId, "❌ Gagal membuat backup.");
      });

      archive.pipe(output);
      // Masukkan semua file di folder, abaikan folder node_modules
      archive.glob('**/*', { ignore: ['node_modules/**', 'backup_script.zip'] });
      archive.finalize();
      return;
    }

      
      
          // ================= 5.5 DETAIL ORDER OTP (ADMIN - 3 LAYOUT) =================
    if (data.startsWith('admin_cekotp|')) {
      const [, trxId, targetId, page] = data.split('|');
      bot.answerCallbackQuery(query.id);

      const dbTrx = bacaTrx();
      const trxData = dbTrx.find(t => t.id_trx === trxId);
      if (!trxData) return bot.answerCallbackQuery(query.id, { text: 'Data tidak ditemukan.', show_alert: true });

      const dbUsers = bacaDatabase();
      const targetUser = dbUsers.find(u => String(u.id) === String(targetId)) || { saldo: 0, nama: 'User' };
      const dispNama = targetUser.nama || '-';
      
      const waktuReq = new Date(trxData.waktu).toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'});
      const harga = formatRp(trxData.harga);
      
      let text = '';
      let keyboard = [];

      // 1. LAYOUT SUCCES
      if (trxData.status === 'completed') {
          // Asumsi: Saat pending, saldo sudah dipotong. Jadi sebelum potong = saldo saat ini + harga
          const saldoSebelum = formatRp(targetUser.saldo + trxData.harga);
          const saldoSesudah = formatRp(targetUser.saldo);
          
          text = `_Detail Transaksi Order OTP - Succes_\n\n` +
                 `ID Transaksi: ${trxData.id_trx}\n` +
                 `Jenis: Order OTP\n\n` +
                 `Nama: ${dispNama}\n` +
                 `ID User: ${targetId}\n\n` +
                 `Layanan: ${trxData.layanan}\n` +
                 `Nomor: ${trxData.nomor || '-'}\n` +
                 `Kode OTP: ${trxData.otp}\n\n` +
                 `Harga: Rp ${harga}\n` +
                 `Status: Sukses\n\n` +
                 `Waktu Request: ${waktuReq} WIB\n` +
                 `Waktu Selesai: ${waktuReq} WIB\n\n` +
                 `Saldo Sebelum: Rp ${saldoSebelum}\n` +
                 `Saldo Sesudah: Rp ${saldoSesudah}`;
                 
          keyboard.push([
              { text: 'Kembali', callback_data: `admin_user_trx|${targetId}|${page}` },
              { text: 'Menu Admin', callback_data: 'admin_menu' }
          ]);
      } 
      // 2. LAYOUT PENDING
      else if (trxData.status === 'waiting' || trxData.status === 'pending') {
          const saldoSebelum = formatRp(targetUser.saldo + trxData.harga);
          
          text = `_Detail Transaksi Order OTP - Pending_\n\n` +
                 `ID Transaksi: ${trxData.id_trx}\n` +
                 `Jenis: Order OTP\n\n` +
                 `Nama: ${dispNama}\n` +
                 `ID User: ${targetId}\n\n` +
                 `Layanan: ${trxData.layanan}\n` +
                 `Nomor: ${trxData.nomor || '-'}\n` +
                 `Kode OTP: Belum Diterima\n\n` +
                 `Harga: Rp ${harga}\n` +
                 `Status: Menunggu OTP\n\n` +
                 `Waktu Request: ${waktuReq} WIB\n` +
                 `Waktu Expired: 15 Menit\n` +
                 `Sisa Waktu: Sedang berjalan\n\n` +
                 `Saldo Sebelum: Rp ${saldoSebelum}\n` +
                 `Saldo Sesudah: Belum Dikembalikan\n\n` +
                 `Pesan ini masih menunggu kode OTP masuk. Silahkan cek status secara berkala atau kirim pengingat ke user.`;

          keyboard = [
              [{ text: 'Kirim Pesan ke User', callback_data: `admin_remind_otp|${trxId}|${targetId}` }],
              [
                  // MENGGUNAKAN FUNGSI YANG SAMA DENGAN USER (cek_hist & batal_hist) ditambah penanda 'admin'
                  { text: 'Cek Status', callback_data: `cek_hist|${trxId}|${page}|admin|${targetId}`, style: 'primary' },
                  { text: 'Batalkan', callback_data: `batal_hist|${trxId}|${page}|admin|${targetId}`, style: 'danger' }
              ],
              [
                  { text: 'Kembali', callback_data: `admin_user_trx|${targetId}|${page}` },
                  { text: 'Menu Admin', callback_data: 'admin_menu' }
              ]
          ];
      } 
      // 3. LAYOUT BATALKAN
      else {
          const saldoSebelum = formatRp(targetUser.saldo - trxData.harga);
          const saldoSesudah = formatRp(targetUser.saldo);
          
          text = `_Detail Transaksi Order OTP - Dibatalkan_\n\n` +
                 `ID Transaksi: ${trxData.id_trx}\n` +
                 `Jenis: Order OTP\n\n` +
                 `Nama: ${dispNama}\n` +
                 `ID User: ${targetId}\n\n` +
                 `Layanan: ${trxData.layanan}\n` +
                 `Nomor: ${trxData.nomor || '-'}\n` +
                 `Kode OTP: Tidak Diterima\n\n` +
                 `Harga: Rp ${harga}\n` +
                 `Status: Dibatalkan\n\n` +
                 `Waktu Request: ${waktuReq} WIB\n` +
                 `Waktu Dibatalkan: ${waktuReq} WIB\n` +
                 `Alasan: Dibatalkan oleh user / Melewati batas waktu / OTP tidak masuk\n\n` +
                 `Saldo Sebelum: Rp ${saldoSebelum}\n` +
                 `Saldo Sesudah: Rp ${saldoSesudah}\n\n` +
                 `Saldo sudah dikembalikan karena transaksi dibatalkan.`;
                 
          keyboard.push([
              { text: 'Kembali', callback_data: `admin_user_trx|${targetId}|${page}` },
              { text: 'Menu Admin', callback_data: 'admin_menu' }
          ]);
      }

      safeEdit(chatId, messageId, text, keyboard, 'Markdown');
      return;
    }


          // ================= FITUR KIRIM PENGINGAT OTP KE USER =================
    if (data.startsWith('admin_remind_otp|')) {
      const [, trxId, targetId] = data.split('|');
      
      const dbTrx = bacaTrx();
      const trxData = dbTrx.find(t => t.id_trx === trxId);
      if (!trxData || (trxData.status !== 'pending' && trxData.status !== 'waiting')) {
          return bot.answerCallbackQuery(query.id, { text: 'Transaksi tidak pending.', show_alert: true });
      }

      const dbUsers = bacaDatabase();
      const targetUser = dbUsers.find(u => String(u.id) === String(targetId));
      const waktuReq = new Date(trxData.waktu).toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'});
      
      const pesanUser = `<i>⏳ Pesanan Order OTP Masih Pending</i>\n\n` +
                        `Halo <b>${targetUser ? targetUser.nama : 'Kak'}</b> 👋,\n` +
                        `Pesanan Order OTP kamu masih menunggu kode OTP masuk.\n\n` +
                        `<b>ID Transaksi:</b> ${trxId}\n` +
                        `<b>Layanan:</b> ${trxData.layanan}\n` +
                        `<b>Nomor:</b> ${trxData.nomor}\n\n` +
                        `<b>Harga:</b> Rp ${formatRp(trxData.harga)}\n` +
                        `<b>Status:</b> Menunggu OTP\n\n` +
                        `<b>Waktu Request:</b> ${waktuReq} WIB\n` +
                        `<b>Waktu Expired:</b> 15 Menit\n` +
                        `<b>Sisa Waktu:</b> Sedang berjalan\n\n` +
                        `<pre>💡 Mohon tunggu sebentar, kode OTP akan otomatis masuk jika sudah tersedia. Jika sudah melewati batas waktu, pesanan akan otomatis dibatalkan dan saldo dikembalikan.</pre>`;
      
      // Ambil CS_URL dari config untuk tombol Laporan Kendala
      const { CS_URL } = require('./config');

      // Penyesuaian tata letak tombol sesuai permintaan
      const keyboardUser = [
          [{ text: 'Salin Nomor', copy_text: { text: String(trxData.nomor) } }],
          [
              { text: 'Cek Status', callback_data: `cek_hist|${trxId}|1`, style: 'primary' },
              { text: 'Batalkan', callback_data: `batal_hist|${trxId}|1`, style: 'danger' }
          ],
          [
              { text: 'Menu Utama', callback_data: 'menu' },
              { text: 'Lapor Kendala', url: CS_URL } // Mengarah ke owner/admin
          ]
      ];

      // parse_mode diubah menjadi 'HTML' agar tag <b> dan <i> terbaca dengan baik
      bot.sendMessage(targetId, pesanUser, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardUser } })
         .then(() => {
             bot.answerCallbackQuery(query.id, { text: '✅ Pengingat berhasil dikirim ke user!', show_alert: true });
         })
         .catch(() => {
             bot.answerCallbackQuery(query.id, { text: '❌ Gagal mengirim pesan. Bot mungkin diblokir user.', show_alert: true });
         });
      return;
    }


      
      
        // ================= 1. MENU UTAMA RIWAYAT =================
    if (data === 'menu_history') {
      bot.answerCallbackQuery(query.id);
      
      const text = `<blockquote>` +
                   `┌ 📜 <b>RIWAYAT TRANSAKSI</b>\n` +
                   `├ Pilih kategori riwayat di bawah ini.\n` +
                   `└ Kamu bisa melihat detail setiap transaksi.\n\n` +
                   `💙 Silakan pilih riwayat:` +
                   `</blockquote>`;
                   
      const keyboard = [
        [
          { text: 'Riwayat Deposit', callback_data: 'history_depo|1', style: 'primary' },
          { text: 'Riwayat Order OTP', callback_data: 'history_otp|1', style: 'primary' }
        ],
        [{ text: 'Kembali', callback_data: 'menu', style: 'primary' }]
      ];
      safeEdit(chatId, messageId, text, keyboard, 'HTML');
      return;
    }

    // ================= 2. DAFTAR RIWAYAT DEPOSIT (PAGINATION) =================
    if (data.startsWith('history_depo|')) {
      const page = parseInt(data.split('|')[1]) || 1;
      bot.answerCallbackQuery(query.id);

      const dbDepo = bacaDeposit();
      
      // Ambil data KHUSUS user ini, dan balik urutannya (terbaru di paling atas)
      const userDepo = dbDepo.filter(d => d.userId === userId || d.user_id === userId).reverse();

      if (userDepo.length === 0) {
          return bot.answerCallbackQuery(query.id, { text: '❌ Kamu belum memiliki riwayat deposit.', show_alert: true });
      }

      // Kalkulasi Ringkasan Data
      const totalDeposit = userDepo.length;
      const totalSaldoMasuk = userDepo.filter(d => d.status === 'success').reduce((acc, curr) => acc + curr.amount, 0);
      const totalKeluar = userDepo.filter(d => d.status === 'success').reduce((acc, curr) => acc + (curr.final_price || curr.total), 0);

      // Sistem Pagination
      const limit = 6;
      const totalPages = Math.ceil(userDepo.length / limit);
      const offset = (page - 1) * limit;
      const currentItems = userDepo.slice(offset, offset + limit);

      // Teks beserta penambahan informasi Keterangan Warna (Legenda)
      const text = `<blockquote>` +
                   `┌ 💳 <b>RIWAYAT DEPOSIT</b>\n` +
                   `├ 📊 Total Deposit : ${totalDeposit} Transaksi\n` +
                   `├ 💰 Total Saldo Masuk : Rp ${formatRp(totalSaldoMasuk)}\n` +
                   `├ 💸 Total Pengeluaran : Rp ${formatRp(totalKeluar)}\n` +
                   `└ 📑 Halaman : ${page} dari ${totalPages}\n\n` +
                   `┌ 🎨 <b>KETERANGAN WARNA</b>\n` +
                   `├ 🟢 Hijau : Transaksi Sukses\n` +
                   `├ 🔵 Biru : Transaksi Pending\n` +
                   `└ 🔴 Merah : Batal / Kadaluarsa\n\n` +
                   `💙 Klik tombol untuk melihat detail:` +
                   `</blockquote>`;

      // Buat tombol ID sejajar 2 kolom tanpa emoji dengan warna dinamis
      const idButtons = currentItems.map(d => {
          // Penentuan warna / style tombol berdasarkan status
          let btnStyle = 'primary'; // Biru (Pending)
          if (d.status === 'success') {
              btnStyle = 'success'; // Hijau (Sukses)
          } else if (d.status === 'canceled' || d.status === 'expired') {
              btnStyle = 'danger'; // Merah (Batal/Kadaluarsa)
          }

          // Format teks: ID_TRX | Nominal (contoh: id983hjs | 50.000)
          let nominalTeks = formatRp(d.amount); 
          let teksTombol = `${d.id_trx} | ${nominalTeks}`;

          return { text: teksTombol, callback_data: `detail_depo|${d.id_trx}|${page}`, style: btnStyle };
      });
      const keyboard = chunkArray(idButtons, 2);

      // Navigasi Bawah (Kembali, Page, Next)
      const navButtons = [];
      if (page > 1) navButtons.push({ text: '⬅️ Prev', callback_data: `history_depo|${page - 1}`, style: 'primary' });
      navButtons.push({ text: `${page}/${totalPages}`, callback_data: 'ignore', style: 'primary' });
      if (page < totalPages) navButtons.push({ text: 'Next ➡️', callback_data: `history_depo|${page + 1}`, style: 'primary' });
      
      keyboard.push(navButtons);
      keyboard.push([{ text: 'Kembali ke Menu Riwayat', callback_data: 'menu_history', style: 'primary' }]);

      safeEdit(chatId, messageId, text, keyboard, 'HTML');
      return;
    }

           

       // ================= 4. DAFTAR RIWAYAT ORDER OTP (LIST 1 KOLOM) =================
    if (data.startsWith('history_otp|')) {
      const page = parseInt(data.split('|')[1]) || 1;
      bot.answerCallbackQuery(query.id);

      const dbTrx = bacaTrx(); 
      const userTrx = dbTrx.filter(t => t.user_id === userId).reverse();

      if (userTrx.length === 0) {
          return bot.answerCallbackQuery(query.id, { text: '❌ Kamu belum memiliki riwayat pesanan.', show_alert: true });
      }

      // Kalkulasi Ringkasan Data
      const totalOrder = userTrx.length;
      const aktifOrder = userTrx.filter(t => t.status === 'waiting' || t.status === 'pending').length;

      // Sistem Pagination
      const limit = 6;
      const totalPages = Math.ceil(totalOrder / limit);
      const offset = (page - 1) * limit;
      const currentItems = userTrx.slice(offset, offset + limit);

      // Teks List Tanpa Blockquote
      const text = `Pesanan & SMS · Semua\n\n` +
                   `${aktifOrder} aktif · ${totalOrder} total · halaman ${page}/${totalPages}\n\n` +
                   `Pilih pesanan untuk melihat nomor dan SMS. Empat digit terakhir membantu membedakan pesanan.`;

      const keyboard = [];

      // Susun tombol 6 baris ke bawah (1 kolom)
      currentItems.forEach(t => {
          let statusLabel = 'pending';
          if (t.status === 'completed') statusLabel = 'sukses';
          else if (t.status === 'canceled' || t.status === 'cancelled' || t.status === 'expired') statusLabel = 'batal';
          
          const nomor4Digit = t.nomor ? String(t.nomor).slice(-4) : 'xxxx';
          const namaLayanan = t.layanan.substring(0, 15); // Potong agar rapi
          
          const teksTombol = `${namaLayanan} • ${statusLabel} • ${nomor4Digit}`;
          keyboard.push([{ text: teksTombol, callback_data: `detail_otp|${t.id_trx}|${page}` }]);
      });

            // Baris Navigasi Halaman
      const navRow = [];
      
      if (page > 1) {
          navRow.push({ text: 'Sebelumnya', callback_data: `history_otp|${page - 1}` });
      }
      
      // Baris navRow.push untuk penghitung halaman telah dihapus sepenuhnya di sini
      
      if (page < totalPages) {
          navRow.push({ text: 'Selanjutnya', callback_data: `history_otp|${page + 1}` });
      }
      
      // Mencegah baris kosong terkirim jika transaksi hanya 1 halaman
      if (navRow.length > 0) {
          keyboard.push(navRow);
      }


      // Baris Aksi (Perbarui & Website)
      const { WEB_URL } = require('./config');
      keyboard.push([
          { text: 'Perbarui', callback_data: `history_otp|${page}` },
          { text: 'Website Order OTP', url: WEB_URL }
      ]);
      
      keyboard.push([{ text: 'Kembali ke Menu Riwayat', callback_data: 'menu_history' }]);

      safeEdit(chatId, messageId, text, keyboard, 'HTML');
      return;
    }

      
      // ================= 5. DETAIL RIWAYAT ORDER OTP (DINAMIS) =================
    if (data.startsWith('detail_otp|')) {
      const [, trxId, pageStr] = data.split('|');
      const page = parseInt(pageStr) || 1;
      bot.answerCallbackQuery(query.id);

      const dbTrx = bacaTrx();
      const trxData = dbTrx.find(t => t.id_trx === trxId);
      if (!trxData) return bot.answerCallbackQuery(query.id, { text: '❌ Data transaksi tidak ditemukan.', show_alert: true });

      const { CS_URL } = require('./config');
      const waktuFormat = formatWaktuRiwayat(trxData.waktu);
      
      let text = '';
      let keyboard = [];

      // 5.A. LAYOUT COMPLETED (SELESAI)
      if (trxData.status === 'completed') {
          text = `<b>OTP Berhasil Diterima</b>\n${trxData.layanan} · Indonesia\n\n` +
                 `Kode OTP: <code>${trxData.otp}</code>\n\n` +
                 `Nomor: <code>${trxData.nomor}</code>\n` +
                 `Harga: Rp ${formatRp(trxData.harga)}\n` +
                 `Waktu: ${waktuFormat}\n` +
                 `Status: Completed\n\n` +
                 `Kode sudah tersimpan di detail pesanan. Jangan bagikan kode ini ke siapa pun.\n\n` +
                 `ID Pesanan: <code>${trxData.id_trx}</code>`;
          
          keyboard = [
              [
                { text: 'Salin Nomor', copy_text: { text: trxData.nomor } },
                { text: 'Salin Kode OTP', copy_text: { text: String(trxData.otp) }, style: 'primary' }
              ],
              [{ text: 'Beli Nokos Lagi', callback_data: 'menu_services' }],
              [{ text: 'Laporkan Kendala', url: CS_URL }],
              [
                { text: 'Kembali', callback_data: `history_otp|${page}` },
                { text: 'Menu Utama', callback_data: 'menu' }
              ]
          ];
      } 
      // 5.B. LAYOUT PENDING
      else if (trxData.status === 'waiting' || trxData.status === 'pending') {
          text = `<b>Menunggu Kode OTP!!</b>\n${trxData.layanan} · Indonesia\n\n` +
                 `Kode OTP: Belum Tersedia\n\n` +
                 `Nomor: <code>${trxData.nomor}</code>\n` +
                 `Harga: Rp ${formatRp(trxData.harga)}\n` +
                 `Waktu: ${waktuFormat}\n` +
                 `Status: Pending\n\n` +
                 `Nomor sedang aktif dan menunggu SMS. Silahkan tunggu sebentar, biasanya kode masuk dalam 1-2 menit.\n\n` +
                 `Jangan bagikan nomor ini ke siapa pun selama masih pending.\n\n` +
                 `ID Pesanan: <code>${trxData.id_trx}</code>`;

          keyboard = [
              [{ text: 'Salin Nomor', copy_text: { text: trxData.nomor } }],
              [{ text: 'Cek Status', callback_data: `cek_hist|${trxData.id_trx}|${page}` , style: 'primary' }],
              [{ text: 'Batalkan Pesanan', callback_data: `batal_hist|${trxData.id_trx}|${page}`, style: 'danger' }],
              [{ text: 'Laporkan Kendala', url: CS_URL }],
              [
                { text: 'Kembali', callback_data: `history_otp|${page}` },
                { text: 'Menu Utama', callback_data: 'menu' }
              ]
          ];
      } 
      // 5.C. LAYOUT DIBATALKAN / KADALUARSA
      else {
          text = `<b>Pesanan Dibatalkan</b>\n${trxData.layanan} · Indonesia\n\n` +
                 `Kode OTP: -\n\n` +
                 `Nomor: <code>${trxData.nomor}</code>\n` +
                 `Harga: Rp ${formatRp(trxData.harga)}\n` +
                 `Waktu: ${waktuFormat}\n` +
                 `Status: Dibatalkan\n\n` +
                 `Pesanan ini dibatalkan dan tidak ada kode OTP yang masuk. Saldo tidak terpotong / sudah dikembalikan jika sebelumnya terpotong.\n\n` +
                 `ID Pesanan: <code>${trxData.id_trx}</code>`;

          keyboard = [
              [{ text: 'Salin Nomor', copy_text: { text: trxData.nomor } }],
              [{ text: 'Beli Nokos Lagi', callback_data: 'menu_services' }],
              [{ text: 'Laporkan Kendala', url: CS_URL }],
              [
                { text: 'Kembali', callback_data: `history_otp|${page}` },
                { text: 'Menu Utama', callback_data: 'menu' }
              ]
          ];
      }

      safeEdit(chatId, messageId, text, keyboard, 'HTML');
      return;
    }


              // ================= CEK STATUS OTP (UNIVERSAL: USER & ADMIN) =================
    if (data.startsWith('cek_hist|')) {
      // Split mendeteksi apakah parameter ke-4 adalah 'admin'
      const [, trxId, page, role, targetId] = data.split('|');
      let dbTrx = bacaTrx();
      let trxData = dbTrx.find(t => t.id_trx === trxId);

      if (!trxData) return bot.answerCallbackQuery(query.id, { text: 'Transaksi tidak ditemukan.', show_alert: true });

      bot.answerCallbackQuery(query.id, { text: 'Mengecek OTP ke pusat...' });
      const res = await checkOrderStatus(trxData.provider_trx);

      if (res.status === 'completed' && res.otp_code) {
          trxData.status = 'completed';
          trxData.otp = res.otp_code;
          
          // MENCEGAH DOUBLE LOG DAN MEMPERBAIKI NAMA FUNGSI
          if (!trxData.log_sent) {
              trxData.log_sent = true;
              kirimLogSuksesOTP(trxData, res.otp_code); // Tadi namanya salah dan parameternya kurang pas
          }
          simpanTrx(dbTrx);
          
          // Arahkan kembali render UI sesuai siapa yang menekan tombol
          if (role === 'admin') {
              query.data = `admin_cekotp|${trxId}|${targetId}|${page}`;
          } else {
              query.data = `detail_otp|${trxId}|${page}`; 
          }
          bot.emit('callback_query', query);
      } else {
          bot.answerCallbackQuery(query.id, { text: `OTP belum masuk. Status pusat: ${res.status || 'waiting'}`, show_alert: true });
      }
      return;
    }


    // ================= BATALKAN PESANAN (UNIVERSAL: USER & ADMIN) =================
    if (data.startsWith('batal_hist|')) {
      const [, trxId, page, role, targetId] = data.split('|');
      let dbTrx = bacaTrx();
      let trxIndex = dbTrx.findIndex(t => t.id_trx === trxId);
      let trxData = dbTrx[trxIndex];

      if (!trxData) return bot.answerCallbackQuery(query.id, { text: 'Transaksi tidak ditemukan.', show_alert: true });

      // Validasi 2 Menit (120000 ms)
      const orderTime = new Date(trxData.waktu).getTime();
      const timeDiff = Date.now() - orderTime;
      if (timeDiff < 120000) {
          const sisa = Math.ceil((120000 - timeDiff) / 1000);
          return bot.answerCallbackQuery(query.id, { text: `Tunggu ${sisa} detik lagi untuk membatalkan pesanan.`, show_alert: true });
      }

      bot.answerCallbackQuery(query.id, { text: 'Membatalkan pesanan...' });
      const res = await cancelOrder(trxData.provider_trx);
      
      if (res.success || (res.message && res.message.toLowerCase().includes('batal'))) {
          // Kembalikan Saldo User
          let dbUsers = bacaDatabase();
          let realUserId = role === 'admin' ? targetId : trxData.user_id;
          let userIndex = dbUsers.findIndex(u => String(u.id) === String(realUserId));
          
          if (userIndex !== -1) {
              dbUsers[userIndex].saldo += trxData.harga;
              simpanDatabase(dbUsers);
          }

          // Update Status ke Canceled
          trxData.status = 'canceled';
          simpanTrx(dbTrx);
          
          const waktuReq = new Date(trxData.waktu).toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'});

          // Kirim pesan otomatis ke user jika dibatalkan (Oleh sistem / Admin)
          const pesanBatal = `_Order OTP Dibatalkan_\n\n` +
                             `Halo ${dbUsers[userIndex]?.nama || 'Kak'},\n` +
                             `Pesanan Order OTP kamu telah dibatalkan.\n\n` +
                             `ID Transaksi: ${trxId}\n` +
                             `Layanan: ${trxData.layanan}\n` +
                             `Nomor: ${trxData.nomor}\n\n` +
                             `Harga: Rp ${formatRp(trxData.harga)}\n` +
                             `Saldo Dikembalikan: Rp ${formatRp(trxData.harga)}\n\n` +
                             `Waktu Request: ${waktuReq} WIB\n` +
                             `Waktu Dibatalkan: ${new Date().toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'})} WIB\n\n` +
                             `Saldo kamu sudah dikembalikan dan bisa digunakan untuk order lagi.`;
                             
          const keyboardBatal = [
              [{ text: 'Order OTP Lagi', callback_data: 'menu_services', style: 'primary' }],
              [{ text: 'Menu Utama', callback_data: 'menu' }]
          ];
          
          bot.sendMessage(trxData.user_id, pesanBatal, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboardBatal } }).catch(()=>{});

          // Arahkan kembali render UI 
          if (role === 'admin') {
              query.data = `admin_cekotp|${trxId}|${targetId}|${page}`;
          } else {
              query.data = `detail_otp|${trxId}|${page}`; 
          }
          bot.emit('callback_query', query);
      } else {
          bot.answerCallbackQuery(query.id, { text: `Gagal membatalkan pesanan dari pusat.`, show_alert: true });
      }
      return;
    }

      
          // ================= 3. DETAIL RIWAYAT DEPOSIT =================
    if (data.startsWith('detail_depo|')) {
      const [, trxId, pageStr] = data.split('|');
      const page = parseInt(pageStr) || 1;
      bot.answerCallbackQuery(query.id);

      const dbDepo = bacaDeposit();
      const depo = dbDepo.find(d => d.id_trx === trxId);

      if (!depo) return bot.answerCallbackQuery(query.id, { text: '❌ Data transaksi tidak ditemukan.', show_alert: true });

      const waktuFormat = new Date(depo.created_at || depo.waktu).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      
      // Terjemahkan status ke bahasa Indonesia
      let statusText = depo.status;
      if (statusText === 'success') statusText = '✅ Sukses';
      else if (statusText === 'pending') statusText = '⏳ Pending (Menunggu Pembayaran)';
      else if (statusText === 'canceled' || statusText === 'expired') statusText = '❌ Batal / Kedaluwarsa';

      // Format Teks Bersih (Tanpa Blockquote)
      const text = `📄 <b>DETAIL TRANSAKSI DEPOSIT</b>\n\n` +
                   `🆔 <b>ID TRX:</b> <code>${depo.id_trx}</code>\n` +
                   `💰 <b>Nominal Saldo:</b> Rp ${formatRp(depo.amount)}\n` +
                   `💵 <b>Total Bayar:</b> Rp ${formatRp(depo.final_price || depo.total)}\n` +
                   `⏰ <b>Waktu:</b> ${waktuFormat} WIB\n` +
                   `📊 <b>Status:</b> ${statusText}`;

      // Tombol kembali membawa variabel page agar user tidak kembali ke halaman 1 terus-menerus
      const keyboard = [
        [{ text: `Kembali ke Halaman ${page}`, callback_data: `history_depo|${page}`, style: 'primary' }],
        [{ text: 'Menu Utama', callback_data: 'menu', style: 'primary' }]
      ];

      safeEdit(chatId, messageId, text, keyboard, 'HTML');
      return;
    }

      
        // ================= 1. MENU UTAMA DEPOSIT =================
    if (data === 'menu_deposit') {
      const { DEPO_V1_ACTIVE, DEPO_V2_ACTIVE } = bacaSettings();
      bot.answerCallbackQuery(query.id);

      const text = `<blockquote>` +
                   `┌ 💳 <b>PILIH JALUR DEPOSIT</b>\n` +
                   `├ 1. Pilih server V1 atau V2.\n` +
                   `├ 2. Tentukan nominal isi saldo.\n` +
                   `└ 3. Scan QRIS dan bayar sesuai Total.\n\n` +
                   `💙 Silakan pilih server di bawah ini:` +
                   `</blockquote>`;

      const keyboard = [
        [
          { text: 'Deposit V1', callback_data: DEPO_V1_ACTIVE ? 'depo_menu|v1' : 'depo_off|V1', style: DEPO_V1_ACTIVE ? 'primary' : 'danger' },
          { text: 'Deposit V2', callback_data: DEPO_V2_ACTIVE ? 'depo_menu|v2' : 'depo_off|V2', style: DEPO_V2_ACTIVE ? 'primary' : 'danger' }
        ],
        [{ text: 'Menu Utama', callback_data: 'menu', style: 'primary' }]
      ];
      safeEdit(chatId, messageId, text, keyboard, 'HTML');
      return;
    }

    if (data.startsWith('depo_off|')) {
      const versi = data.split('|')[1];
      return bot.answerCallbackQuery(query.id, { text: `❌ Deposit ${versi} sedang tidak aktif.`, show_alert: true });
    }

    // ================= 2. MENU PILIH NOMINAL (V1 & V2) =================
    if (data.startsWith('depo_menu|')) {
      bot.answerCallbackQuery(query.id);
      const versi = data.split('|')[1]; // 'v1' atau 'v2'

      const text = `<blockquote>` +
                   `┌ 💰 <b>NOMINAL DEPOSIT (${versi.toUpperCase()})</b>\n` +
                   `├ Pilih nominal instan di bawah ini,\n` +
                   `└ Atau ketik manual jumlahnya.\n\n` +
                   `💙 Silakan tentukan jumlah saldo:` +
                   `</blockquote>`;
      const keyboard = [
        [{ text: '✎ Masukkan Nominal Manual', callback_data: `depo_manual|${versi}`, style: 'primary' }],
        [
          { text: '2.000', callback_data: `depo_exec|${versi}|2000`, style: 'primary' },
          { text: '5.000', callback_data: `depo_exec|${versi}|5000`, style: 'primary' },
          { text: '10.000', callback_data: `depo_exec|${versi}|10000`, style: 'primary' }
        ],
        [
          { text: '25.000', callback_data: `depo_exec|${versi}|25000`, style: 'primary' },
          { text: '50.000', callback_data: `depo_exec|${versi}|50000`, style: 'primary' },
          { text: '100.000', callback_data: `depo_exec|${versi}|100000`, style: 'primary' }
        ],
        [{ text: 'Kembali', callback_data: 'menu_deposit', style: 'primary' }]
      ];
      safeEdit(chatId, messageId, text, keyboard, 'HTML');
      return;
    }

    // ================= 3. INPUT NOMINAL MANUAL =================
    if (data.startsWith('depo_manual|')) {
      const versi = data.split('|')[1];
      bot.answerCallbackQuery(query.id);
      await bot.deleteMessage(chatId, messageId).catch(() => {});
      
      const textManual = `<blockquote>` +
                         `┌ ⌨ <b>DEPOSIT MANUAL (${versi.toUpperCase()})</b>\n` +
                         `└ Silakan balas (reply) pesan ini dengan angka nominal deposit yang kamu inginkan.\n\n` +
                         `<i>Contoh: 15000</i>` +
                         `</blockquote>`;
                         
      bot.sendMessage(chatId, textManual, { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } });
      
      // Simpan sesi sementara untuk mengingat user pilih V1/V2
      userSessions[userId] = { pendingDepoVersi: versi }; 
      return;
    }

    // ================= 4. EKSEKUSI PEMBUATAN QRIS =================
    if (data.startsWith('depo_exec|')) {
      bot.answerCallbackQuery(query.id, { text: 'Membuat QRIS Deposit...' });
      const [, versi, nominalStr] = data.split('|');
      const nominal = parseInt(nominalStr);

      if (versi === 'v1') {
        prosesDepositV1(chatId, userId, nominal, messageId, query.from.username);
      } else {
        prosesDepositV2(chatId, userId, nominal, messageId, query.from.username);
      }
      return;
    }

    // ================= 5. CEK STATUS DEPOSIT =================
    if (data.startsWith('cek_depo|')) {
      const myTrx = data.split('|')[1];
      let dbDepo = bacaDeposit();
      let depoData = dbDepo.find(d => d.id_trx === myTrx);

      if (!depoData) return bot.answerCallbackQuery(query.id, { text: 'Data tidak ditemukan.', show_alert: true });
      if (depoData.status === 'success') return bot.answerCallbackQuery(query.id, { text: 'Sudah sukses.', show_alert: true });

      bot.answerCallbackQuery(query.id, { text: 'Mengecek pembayaran...' });
      
      // Cek sesuai versi
      let res;
      if (depoData.metode === 'V1') res = await checkDepositStatus(depoData.provider_trx);
      else res = await checkDepositStatusV2(depoData.provider_trx);

      if (res.status === 'success' || res.status === 'paid' || res.status === 'settlement') {
        let dbUsers = bacaDatabase();
        let userIndex = dbUsers.findIndex(u => u.id === depoData.userId);
        
        dbUsers[userIndex].saldo += depoData.amount; 
        simpanDatabase(dbUsers);

        depoData.status = 'success';
        simpanDeposit(dbDepo);
        kirimLogDeposit(depoData, depoData.username);

        const textSukses = `<blockquote>` +
                           `┌ ✅ <b>DEPOSIT TELAH BERHASIL</b>\n` +
                           `├ 🆔 TRX : <code>${myTrx}</code>\n` +
                           `├ 💰 Saldo Masuk : Rp ${formatRp(depoData.amount)}\n` +
                           `└ 💳 Saldo Akhir : Rp ${formatRp(dbUsers[userIndex].saldo)}\n\n` +
                           `💙 Terima kasih telah isi saldo.` +
                           `</blockquote>`;
        const keyboardSukses = [
          [
            { text: 'Deposit Lagi', callback_data: 'menu_deposit', style: 'primary' },
            { text: 'Order Layanan', callback_data: 'menu_services', style: 'primary' }
          ]
        ];

        // Karena QRIS adalah foto, kita harus hapus lalu kirim pesan teks
        await bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId, textSukses, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardSukses } });
      } else {
        bot.answerCallbackQuery(query.id, { text: `⏳ Belum masuk. Pastikan nominal transfer PAS.`, show_alert: true });
      }
      return;
    }

    // ================= 6. BATALKAN DEPOSIT =================
    if (data.startsWith('batal_depo|')) {
      const myTrx = data.split('|')[1];
      let dbDepo = bacaDeposit();
      let depoData = dbDepo.find(d => d.id_trx === myTrx);

      if (!depoData) return bot.answerCallbackQuery(query.id, { text: 'Data tidak ditemukan.', show_alert: true });

      // Validasi Timer Batal (1 Menit)
      const timeDiff = Date.now() - new Date(depoData.created_at).getTime();
      if (timeDiff < 60000) { 
          const sisaDetik = 60 - Math.floor(timeDiff / 1000);
          return bot.answerCallbackQuery(query.id, { text: `⏳ Tunggu ${sisaDetik} detik lagi untuk membatalkan manual.`, show_alert: true });
      }

      bot.answerCallbackQuery(query.id, { text: 'Membatalkan...' });
      
      let res;
      if (depoData.metode === 'V1') res = await cancelDeposit(depoData.provider_trx);
      else res = await cancelDepositV2(depoData.provider_trx);

      if (res.success || res.message?.toLowerCase().includes('batal')) {
        depoData.status = 'canceled';
        simpanDeposit(dbDepo);

        const textBatal = `<blockquote>` +
                          `┌ ❌ <b>DEPOSIT DIBATALKAN</b>\n` +
                          `├ TRX <code>${myTrx}</code> telah dibatalkan.\n` +
                          `└ Silakan order ulang jika ingin deposit.` +
                          `</blockquote>`;
        const keyboardBatal = [
          [
            { text: 'Menu Utama', callback_data: 'menu', style: 'primary' },
            { text: 'Deposit Lagi', callback_data: 'menu_deposit', style: 'primary' }
          ]
        ];

        await bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId, textBatal, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardBatal } });
      } else {
        bot.answerCallbackQuery(query.id, { text: `❌ Gagal membatalkan.`, show_alert: true });
      }
      return;
    }
     
    // ================= KEMBALI KE MENU ADMIN =================
    if (data === 'admin_menu') {
      bot.answerCallbackQuery(query.id);
      // Hapus pesan teks pengaturan, lalu kirim ulang foto menu admin agar mulus
      await bot.deleteMessage(chatId, messageId).catch(() => {});
      tampilkanMenuAdmin(chatId);
      return;
    }

    // ================= HALAMAN SETTINGS DEPOSIT =================
    if (data === 'admin_depo_settings') {
      bot.answerCallbackQuery(query.id);
      
      const settings = bacaSettings();
      
      // Menentukan teks dan warna (style) berdasarkan status di database
      const teksV1 = settings.DEPO_V1_ACTIVE ? '🟢 Deposit V1 (Aktif)' : '🔴 Deposit V1 (Nonaktif)';
      const styleV1 = settings.DEPO_V1_ACTIVE ? 'primary' : 'danger'; // Biru jika aktif, Merah jika nonaktif
      
      const teksV2 = settings.DEPO_V2_ACTIVE ? '🟢 Deposit V2 (Aktif)' : '🔴 Deposit V2 (Nonaktif)';
      const styleV2 = settings.DEPO_V2_ACTIVE ? 'primary' : 'danger';

      const text = `<blockquote>` +
                   `┌ ⚙️ <b>PENGATURAN DEPOSIT</b>\n` +
                   `├ <b>Deposit V1 :</b> Integrasi WarungNokos\n` +
                   `└ <b>Deposit V2 :</b> Integrasi https://qris.zpr0.com\n\n` +
                   `┌ 📌 <b>PETUNJUK</b>\n` +
                   `└ Klik tombol di bawah untuk mengubah status Aktif / Nonaktif.\n\n` +
                   `💙 Perubahan akan langsung diterapkan.` +
                   `</blockquote>`;

      const keyboard = [
        [{ text: teksV1, callback_data: 'toggle_depo|V1', style: styleV1 }],
        [{ text: teksV2, callback_data: 'toggle_depo|V2', style: styleV2 }],
        [{ text: 'Kembali ke Menu Admin', callback_data: 'admin_menu', style: 'primary' }]
      ];

      // Hapus pesan foto admin menu, ganti dengan pesan teks ini
      await bot.deleteMessage(chatId, messageId).catch(() => {});
      bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
      return;
    }

    // ================= TOGGLE / SAKELAR DEPOSIT =================
    if (data.startsWith('toggle_depo|')) {
      const versi = data.split('|')[1];
      let settings = bacaSettings();
      
      // Balikkan statusnya (Jika true jadi false, jika false jadi true)
      if (versi === 'V1') settings.DEPO_V1_ACTIVE = !settings.DEPO_V1_ACTIVE;
      if (versi === 'V2') settings.DEPO_V2_ACTIVE = !settings.DEPO_V2_ACTIVE;
      
      simpanSettings(settings); // Simpan perubahan ke database
      
      bot.answerCallbackQuery(query.id, { text: `✅ Status Deposit ${versi} berhasil diperbarui!` });
      
      // Render ulang tombol dengan status terbaru
      const teksV1 = settings.DEPO_V1_ACTIVE ? '🟢 Deposit V1 (Aktif)' : '🔴 Deposit V1 (Nonaktif)';
      const styleV1 = settings.DEPO_V1_ACTIVE ? 'primary' : 'danger';
      const teksV2 = settings.DEPO_V2_ACTIVE ? '🟢 Deposit V2 (Aktif)' : '🔴 Deposit V2 (Nonaktif)';
      const styleV2 = settings.DEPO_V2_ACTIVE ? 'primary' : 'danger';

      const text = `<blockquote>` +
                   `┌ ⚙️ <b>PENGATURAN DEPOSIT</b>\n` +
                   `├ <b>Deposit V1 :</b> Integrasi WarungNokos\n` +
                   `└ <b>Deposit V2 :</b> Integrasi https://qris.zpr0.com\n\n` +
                   `┌ 📌 <b>PETUNJUK</b>\n` +
                   `└ Klik tombol di bawah untuk mengubah status Aktif / Nonaktif.\n\n` +
                   `💙 Perubahan akan langsung diterapkan.` +
                   `</blockquote>`;

      const keyboard = [
        [{ text: teksV1, callback_data: 'toggle_depo|V1', style: styleV1 }],
        [{ text: teksV2, callback_data: 'toggle_depo|V2', style: styleV2 }],
        [{ text: 'Kembali ke Menu Admin', callback_data: 'admin_menu', style: 'primary' }]
      ];

      // Gunakan safeEdit karena ini sesama pesan teks (sangat mulus)
      safeEdit(chatId, messageId, text, keyboard, 'HTML');
      return;
    }

 
      

          // ================= 1. MENU LAYANAN (ANTI DELAY, PRIORITY SORT & REFRESH) =================
    if (data === 'menu_services' || data.startsWith('svc_page|')) {
      // Memecah data callback (contoh: 'svc_page|2|refresh')
      const parts = data.split('|');
      const page = parts.length > 1 ? parseInt(parts[1]) : 1;
      const isRefresh = parts[2] === 'refresh';
      
      // Berikan respon notifikasi kecil di atas layar jika user menekan tombol Perbarui
      if (isRefresh) {
        bot.answerCallbackQuery(query.id, { text: 'Memperbarui daftar layanan...' });
      } else {
        bot.answerCallbackQuery(query.id);
      }

      // Ambil layanan (jika isRefresh true, paksa ambil ulang dari server API)
      const rawServices = await getServices(isRefresh);
      if (rawServices.length === 0) {
          return bot.answerCallbackQuery(query.id, { text: 'Gagal mengambil daftar layanan dari server.', show_alert: true });
      }

      // Daftar layanan populer yang wajib diletakkan di paling atas (urutan prioritas)
      const priorityKeywords = ['whatsapp', 'facebook', 'shopee', 'shoppe', 'instagram', 'tiktok', 'grab', 'telegram'];
      
      const priorityList = [];
      const normalList = [];

      // Pisahkan layanan populer dan layanan biasa
      rawServices.forEach(s => {
          const cleanLower = bersihkanEmoji(s.name).toLowerCase();
          const matchIndex = priorityKeywords.findIndex(kw => cleanLower === kw || cleanLower.startsWith(kw + ' '));
          
          if (matchIndex !== -1) {
              priorityList.push({ ...s, _rank: matchIndex });
          } else {
              normalList.push(s);
          }
      });

      // Urutkan layanan populer sesuai urutan prioritas
      priorityList.sort((a, b) => a._rank - b._rank);

      // Gabungkan kembali: Populer di atas, sisanya di bawah
      const services = [...priorityList, ...normalList];

      // Pengaturan Grid 2 kolom x 4 baris = 8 tombol per halaman
      const limit = 8;
      const totalPages = Math.ceil(services.length / limit);
      const safePage = page > totalPages ? totalPages : page;
      const offset = (safePage - 1) * limit;
      const currentServices = services.slice(offset, offset + limit);

      // 1. Bagian Atas: Grid layanan 2 kolom
      const buttons = currentServices.map(s => {
          const cleanName = bersihkanEmoji(s.name);
          return { text: cleanName, callback_data: `svc|${s.id}|${cleanName.substring(0,10)}|1` };
      });
      const keyboard = chunkArray(buttons, 2);

      // 2. Baris Navigasi Halaman
      const navButtons = [];
      if (safePage > 1) {
          navButtons.push({ text: '‹ Sebelumnya', callback_data: `svc_page|${safePage - 1}` });
      }
      if (safePage < totalPages) {
          navButtons.push({ text: 'Berikutnya ›', callback_data: `svc_page|${safePage + 1}` });
      }
      if (navButtons.length > 0) {
          keyboard.push(navButtons);
      }

      // 3. Baris Tombol Perbarui (Full Width)
      keyboard.push([
          { text: '↻ Perbarui', callback_data: `svc_page|${safePage}|refresh` }
      ]);

      // 4. Tombol Paling Bawah: Menu Utama (Full Width)
      keyboard.push([
          { text: 'Menu utama', callback_data: 'menu' }
      ]);

      // Format Teks Biasa (Tanpa Blockquote)
      const text = `Beli nomor • 1/4\n` +
                   `Pilih layanan\n\n` +
                   `${services.length} layanan • halaman ${safePage}/${totalPages}\n\n` +
                   `Pilih layanan, atau ketik namanya untuk mencari.`;

      // Transisi mulus dari Foto (Menu Utama) atau Teks (Antar Halaman)
      if (query.message.photo) {
          await bot.deleteMessage(chatId, messageId).catch(() => {});
          await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
      } else {
          await bot.editMessageText(text, {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: { inline_keyboard: keyboard }
          }).catch(() => {});
      }
      return;
    }

     
                   
   
      
          // ================= 2. MENU NEGARA (HARGA TERMURAH & 1 KOLOM) =================
    if (data.startsWith('svc|')) {
      // Deteksi apakah ada parameter tambahan '|refresh' dari tombol Perbarui
      const parts = data.split('|');
      const serviceId = parts[1];
      const serviceName = parts[2];
      const page = parseInt(parts[3]) || 1;
      const isRefresh = parts[4] === 'refresh';

      if (isRefresh) {
        bot.answerCallbackQuery(query.id, { text: 'Memperbarui harga terbaru...' });
      } else {
        bot.answerCallbackQuery(query.id);
      }

      // Ambil produk (jika isRefresh true, paksa ambil data baru dari API)
      const allProducts = await getProducts(serviceId, '', isRefresh);
      
      // Hitung stok dan cari harga termurah per negara
      const countryStats = {};
      const feeMultiplier = parseInt(FEE_PERCENT || 0) / 100;

      allProducts.forEach(p => {
          if (p.available > 0) {
              const finalPrice = Math.ceil(p.price + (p.price * feeMultiplier));
              
              if (!countryStats[p.country_id]) {
                  countryStats[p.country_id] = { stock: 0, minPrice: finalPrice };
              }
              countryStats[p.country_id].stock += p.available;
              
              // Simpan harga yang paling murah
              if (finalPrice < countryStats[p.country_id].minPrice) {
                  countryStats[p.country_id].minPrice = finalPrice;
              }
          }
      });

      const allCountries = await getCountries();
      
      // Filter hanya negara yang memiliki stok, lalu sisipkan data minPrice
      let availableCountries = allCountries
          .filter(c => countryStats[c.id] && countryStats[c.id].stock > 0)
          .map(c => ({
              ...c,
              minPrice: countryStats[c.id].minPrice,
              totalStock: countryStats[c.id].stock
          }));

      if (availableCountries.length === 0) {
          return bot.answerCallbackQuery(query.id, { text: 'Stok kosong untuk layanan ini.', show_alert: true });
      }

      // Urutkan negara dari harga termurah ke termahal
      availableCountries.sort((a, b) => a.minPrice - b.minPrice);

      // Pagination: 8 negara per halaman
      const limit = 8;
      const totalPages = Math.ceil(availableCountries.length / limit);
      const safePage = page > totalPages ? totalPages : page;
      const offset = (safePage - 1) * limit;
      const currentCountries = availableCountries.slice(offset, offset + limit);

      const keyboard = [];

      // 1. Bagian Atas: List negara 1 kolom full width (tanpa emoji & style biasa)
      currentCountries.forEach(c => {
          const cleanCountryName = bersihkanEmoji(c.name);
          const btnText = `${cleanCountryName} • mulai Rp ${formatRp(c.minPrice)}`;
          keyboard.push([
              { text: btnText, callback_data: `cty|${serviceId}|${serviceName}|${c.id}|${cleanCountryName.substring(0, 12)}` }
          ]);
      });

      // 2. Baris Navigasi Halaman
      const navButtons = [];
      if (safePage > 1) {
          navButtons.push({ text: '‹ Sebelumnya', callback_data: `svc|${serviceId}|${serviceName}|${safePage - 1}` });
      }
      if (safePage < totalPages) {
          navButtons.push({ text: 'Berikutnya ›', callback_data: `svc|${serviceId}|${serviceName}|${safePage + 1}` });
      }
      if (navButtons.length > 0) {
          keyboard.push(navButtons);
      }

      // 3. Baris Pencarian & Perbarui
      keyboard.push([
          { text: 'Cari negara', callback_data: `search_cty|${serviceId}|${serviceName}` },
          { text: '↻ Perbarui', callback_data: `svc|${serviceId}|${serviceName}|${safePage}|refresh` }
      ]);

      // 4. Baris Panduan Layanan (Full Width)
      keyboard.push([
          { text: 'Panduan layanan ↗', callback_data: `guide_svc|${serviceId}|${serviceName}|${safePage}` }
      ]);

      // 5. Baris Kembali & Menu Utama
      keyboard.push([
          { text: '‹ Kembali', callback_data: 'menu_services' },
          { text: 'Menu utama', callback_data: 'menu' }
      ]);

      // Format Teks Biasa (Tanpa Blockquote)
      const text = `Beli nomor • 2/4\n` +
                   `Pilih negara\n\n` +
                   `Layanan: ${serviceName}\n` +
                   `${availableCountries.length} negara tersedia • halaman ${safePage}/${totalPages}\n\n` +
                   `Diurutkan dari harga termurah. Pilih negara untuk melihat harga terbaru.`;

      // Gunakan safeEdit agar transisi dari menu layanan sangat halus tanpa kedip
      safeEdit(chatId, messageId, text, keyboard, 'HTML');
      return;
    }

      
      
         // ================= 3. MENU SERVER / PILIH HARGA (3/4 + BULK QTY) =================
    if (data.startsWith('cty|')) {
      // Format callback_data: cty|serviceId|serviceName|countryId|countryName|qty|action
      const parts = data.split('|');
      const serviceId = parts[1];
      const serviceName = parts[2];
      const countryId = parts[3];
      const countryName = parts[4];
      let qty = parseInt(parts[5]) || 1;
      const action = parts[6] || '';

      // Logika pengaturan jumlah order (+ / -)
      if (action === 'plus') {
          qty += 1;
          bot.answerCallbackQuery(query.id);
      } else if (action === 'minus') {
          if (qty <= 1) {
              return bot.answerCallbackQuery(query.id, { text: 'Minimal order adalah 1 nomor.', show_alert: true });
          }
          qty -= 1;
          bot.answerCallbackQuery(query.id);
      } else if (action === 'refresh') {
          bot.answerCallbackQuery(query.id, { text: 'Memperbarui harga dan stok...' });
      } else {
          bot.answerCallbackQuery(query.id);
      }

      // Ambil produk (jika action === 'refresh', paksa ambil data baru dari API pusat)
      const isRefresh = action === 'refresh';
      const allProducts = await getProducts(serviceId, countryId, isRefresh);
      const availableProducts = allProducts.filter(p => p.available > 0);
      
      if (availableProducts.length === 0) {
          return bot.answerCallbackQuery(query.id, { text: 'Stok kosong di negara ini.', show_alert: true });
      }

      // Kalkulasi total stok dan harga akhir setiap produk
      const totalStock = availableProducts.reduce((acc, p) => acc + p.available, 0);
      const feeMultiplier = parseInt(FEE_PERCENT || 0) / 100;

      const productsWithPrice = availableProducts.map(p => ({
          ...p,
          finalPrice: Math.ceil(p.price + (p.price * feeMultiplier))
      }));

      // Urutkan dari harga termurah, lalu ambil maksimal 6 pilihan harga
      productsWithPrice.sort((a, b) => a.finalPrice - b.finalPrice);
      const products = productsWithPrice.slice(0, 6);

      // Potong nama layanan & negara maksimal 10 karakter agar callback_data aman (< 64 bytes)
      const shortSvc = serviceName.substring(0, 10);
      const shortCty = countryName.substring(0, 10);

      const keyboard = [];

      // 1. Bagian Atas: List harga 1 kolom full width (maksimal 6 button, style biasa)
      products.forEach(p => {
          const btnText = `Rp ${formatRp(p.finalPrice)} • stok ${p.available}`;
          // Menyisipkan 'qty' di akhir callback_data buy| untuk tahap konfirmasi 4/4 nanti
          keyboard.push([
              { text: btnText, callback_data: `buy|${p.id}|${serviceId}|${countryId}|${p.finalPrice}|${shortSvc}|${shortCty}|${qty}` }
          ]);
      });

      // 2. Baris Atur Jumlah Order (+ di kiri, - di kanan)
      keyboard.push([
          { text: '+', callback_data: `cty|${serviceId}|${shortSvc}|${countryId}|${shortCty}|${qty}|plus` },
          { text: '-', callback_data: `cty|${serviceId}|${shortSvc}|${countryId}|${shortCty}|${qty}|minus` }
      ]);

      // 3. Baris Display Jumlah Order (Full Width, hanya info/display)
      keyboard.push([
          { text: `Jumlah Order: ${qty}`, callback_data: 'ignore' }
      ]);

      // 4. Baris Perbarui & Menu Utama
      keyboard.push([
          { text: '↻ Perbarui', callback_data: `cty|${serviceId}|${shortSvc}|${countryId}|${shortCty}|${qty}|refresh` },
          { text: 'Menu utama', callback_data: 'menu' }
      ]);

      // 5. Baris Paling Bawah: Kembali ke List Negara
      keyboard.push([
          { text: '‹ Kembali', callback_data: `svc|${serviceId}|${shortSvc}|1` }
      ]);

      // Format Teks Biasa (Tanpa Blockquote)
      const text = `Beli nomor • 3/4\n` +
                   `Pilih harga\n\n` +
                   `${serviceName} • ${countryName}\n` +
                   `${products.length} pilihan harga\n\n` +
                   `Saldo Anda: Rp ${formatRp(saldoSaatIni)}\n` +
                   `Total Stock: ${formatRp(totalStock)}\n\n` +
                   `Harga untuk 1 nomor. Saldo belum dipotong; periksa ringkasan sebelum konfirmasi.`;

      // Gunakan safeEdit agar pergantian angka (+) / (-) berlangsung sangat halus tanpa kedip
      safeEdit(chatId, messageId, text, keyboard, 'HTML');
      return;
    }

      
      
       

        // ================= 4. PEMBELIAN (BUY - MENDUKUNG BULK ORDER) =================
    if (data.startsWith('buy|')) {
      const parts = data.split('|');
      const productId = parts[1];
      const appId = parts[2];
      const countryId = parts[3];
      const unitPrice = Number(parts[4]);
      const serviceName = parts[5];
      const countryName = parts[6];
      const qty = parseInt(parts[7]) || 1;

      const totalHarga = unitPrice * qty;

      if (saldoSaatIni < totalHarga) {
          const alertText = `Saldo anda tidak cukup\n\nTransaksi: ${serviceName} (${qty}x) | ${countryName}\nSaldo saat ini: Rp ${formatRp(saldoSaatIni)}\nTotal Harga: Rp ${formatRp(totalHarga)}\nKurang: Rp ${formatRp(totalHarga - saldoSaatIni)}\n\nSilahkan deposit terlebih dahulu`;
          return bot.answerCallbackQuery(query.id, { text: alertText, show_alert: true });
      }

      bot.answerCallbackQuery(query.id, { text: `Memproses ${qty} pesanan...` });

      // Potong saldo total sementara
      let userIndex = dbUsers.findIndex(u => u.id === userId);
      dbUsers[userIndex].saldo -= totalHarga;
      simpanDatabase(dbUsers);

      const createdTrxIds = [];
      const createdOrdersData = [];
      const telegramUsername = query.from.username || '';
      let dbTrx = bacaTrx();

      // Looping pemesanan sesuai jumlah qty
      for (let i = 0; i < qty; i++) {
          const resOrder = await createOrder(productId, appId, countryId, serviceName);
          if (resOrder.success && resOrder.data) {
              const myTrx = generateTrxId();
              const newOrder = {
                  id_trx: myTrx,
                  provider_trx: resOrder.data.trxId,
                  user_id: userId,
                  username: telegramUsername,
                  layanan: serviceName,
                  harga: unitPrice,
                  nomor: resOrder.data.phoneNumber,
                  otp: null,
                  waktu: new Date().toISOString(),
                  status: 'waiting'
              };
              dbTrx.push(newOrder);
              createdTrxIds.push(myTrx);
              createdOrdersData.push(newOrder);
          } else {
              break; // Hentikan loop jika stok tiba-tiba habis di tengah jalan
          }
      }

      // Jika semua pesanan gagal dibuat
      if (createdTrxIds.length === 0) {
          dbUsers = bacaDatabase();
          userIndex = dbUsers.findIndex(u => u.id === userId);
          dbUsers[userIndex].saldo += totalHarga;
          simpanDatabase(dbUsers);
          const errMsg = await bot.sendMessage(chatId, `❌ <b>Gagal:</b> Stok habis atau server gangguan. Saldo telah dikembalikan.`, { parse_mode: 'HTML' });
          setTimeout(() => bot.deleteMessage(chatId, errMsg.message_id).catch(()=>{}), 5000);
          return;
      }

      // Refund sebagian jika yang berhasil dibuat lebih sedikit dari qty yang diminta
      if (createdTrxIds.length < qty) {
          const gagalQty = qty - createdTrxIds.length;
          const refundAmount = gagalQty * unitPrice;
          dbUsers = bacaDatabase();
          userIndex = dbUsers.findIndex(u => u.id === userId);
          dbUsers[userIndex].saldo += refundAmount;
          simpanDatabase(dbUsers);
      }

      simpanTrx(dbTrx);

      // Hapus pesan menu server lama dan kirim pesan pesanan baru
      await bot.deleteMessage(chatId, messageId).catch(() => {});
      
      const initialView = renderOrderView(createdTrxIds, 0);
      const sentMsg = await bot.sendMessage(chatId, initialView.text, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: initialView.keyboard }
      });

      // Simpan daftar ID pesanan & halaman aktif di sesi user untuk navigasi & auto-check
      userSessions[userId] = {
          ...userSessions[userId],
          activeOrderIds: createdTrxIds,
          activeOrderPage: 0,
          activeOrderMsgId: sentMsg.message_id
      };

      // Jalankan autoCheckOtp untuk setiap nomor yang berhasil dipesan
      createdOrdersData.forEach(ord => {
          autoCheckOtp(userId, ord.id_trx, ord.provider_trx, chatId, sentMsg.message_id);
      });
      return;
    }

    // ================= NAVIGASI HALAMAN PESANAN (1/3, 2/3, DST) =================
    if (data.startsWith('ord_page|')) {
      const targetIndex = parseInt(data.split('|')[1]) || 0;
      bot.answerCallbackQuery(query.id);

      const session = userSessions[userId];
      if (!session || !session.activeOrderIds) {
          return bot.answerCallbackQuery(query.id, { text: 'Sesi pesanan telah berakhir. Cek melalui Riwayat Transaksi.', show_alert: true });
      }

      session.activeOrderPage = targetIndex;
      const view = renderOrderView(session.activeOrderIds, targetIndex);
      safeEdit(chatId, messageId, view.text, view.keyboard, 'HTML');
      return;
    }

    // ================= 5. CEK OTP (MANUAL) =================
    if (data.startsWith('cek_otp|')) {
      const [, myTrx, pageIndexStr] = data.split('|');
      const pageIndex = parseInt(pageIndexStr) || 0;
      const dbTrx = bacaTrx();
      const trxData = dbTrx.find(t => t.id_trx === myTrx);
      
      if (!trxData) return bot.answerCallbackQuery(query.id, { text: 'Transaksi tidak ditemukan.' });

      bot.answerCallbackQuery(query.id, { text: 'Mengecek OTP...' });
      const res = await checkOrderStatus(trxData.provider_trx);
      
      if (res.status === 'completed' && res.otp_code) {
          trxData.status = 'completed';
          trxData.otp = res.otp_code;

          if (!trxData.log_sent) {
              trxData.log_sent = true;
              kirimLogSuksesOTP(trxData, res.otp_code);
          }
          simpanTrx(dbTrx);

          const trxList = userSessions[userId]?.activeOrderIds || [myTrx];
          const view = renderOrderView(trxList, pageIndex);
          safeEdit(chatId, messageId, view.text, view.keyboard, 'HTML');
      } else {
          bot.answerCallbackQuery(query.id, { text: `⏳ Status: ${res.status || 'waiting'}\nBelum ada OTP yang masuk. Tunggu sebentar lagi ya!`, show_alert: true });
      }
      return;
    }

    // ================= 6. BATALKAN PESANAN =================
    if (data.startsWith('cancel|')) {
      const [, myTrx, pageIndexStr] = data.split('|');
      const pageIndex = parseInt(pageIndexStr) || 0;
      let dbTrx = bacaTrx();
      const trxIndex = dbTrx.findIndex(t => t.id_trx === myTrx);
      const trxData = dbTrx[trxIndex];

      if (!trxData) return bot.answerCallbackQuery(query.id, { text: 'Transaksi tidak ditemukan.' });

      const orderTime = new Date(trxData.waktu).getTime();
      const timeDiff = Date.now() - orderTime;
      if (timeDiff < 120000) {
          const sisa = Math.ceil((120000 - timeDiff) / 1000);
          return bot.answerCallbackQuery(query.id, { text: `❌ Batal ditolak. Tunggu ${sisa} detik lagi untuk membatalkan pesanan.`, show_alert: true });
      }

      bot.answerCallbackQuery(query.id, { text: 'Membatalkan pesanan...' });
      const res = await cancelOrder(trxData.provider_trx);
      
      if (res.success || (res.message && res.message.toLowerCase().includes('batal'))) {
          trxData.status = 'canceled';
          simpanTrx(dbTrx);

          let dbUsers = bacaDatabase();
          let userIndex = dbUsers.findIndex(u => u.id === userId);
          if (userIndex !== -1) {
              dbUsers[userIndex].saldo += trxData.harga;
              simpanDatabase(dbUsers);
          }

          const trxList = userSessions[userId]?.activeOrderIds || [myTrx];
          const view = renderOrderView(trxList, pageIndex);
          safeEdit(chatId, messageId, view.text, view.keyboard, 'HTML');
      } else {
          bot.answerCallbackQuery(query.id, { text: '❌ Gagal membatalkan pesanan dari pusat.', show_alert: true });
      }
      return;
    }

       } catch (err) {
    console.error('[CALLBACK ERROR]', err.message);
    bot.answerCallbackQuery(query.id, { text: `Error sistem: ${err.message}`, show_alert: true });
  }
});

 // ================= FUNGSI AUTO CHECK OTP =================
function autoCheckOtp(userId, myTrx, providerTrx, chatId, messageId) {
  let attempts = 0;
  const maxAttempts = 60; // 5 Menit

  const interval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) return clearInterval(interval);

    try {
        let dbTrx = bacaTrx();
        const trxData = dbTrx.find(t => t.id_trx === myTrx);
        
        // Hentikan pengecekan otomatis jika transaksi sudah dibatalkan atau sudah selesai
        if (!trxData || trxData.status !== 'waiting') {
            return clearInterval(interval);
        }

        const res = await checkOrderStatus(providerTrx);

        if (res.status === 'completed' && res.otp_code) {
          clearInterval(interval);
          
          trxData.status = 'completed';
          trxData.otp = res.otp_code;

          if (!trxData.log_sent) {
              trxData.log_sent = true;
              kirimLogSuksesOTP(trxData, res.otp_code);
          }
          simpanTrx(dbTrx);

          const session = userSessions[userId];
          // Jika user masih berada di pesan pesanan ini, perbarui tampilannya
          if (session && session.activeOrderMsgId === messageId && session.activeOrderIds) {
              const trxIndex = session.activeOrderIds.indexOf(myTrx);
              // Otomatis arahkan tampilan ke nomor yang baru saja mendapatkan OTP
              session.activeOrderPage = trxIndex !== -1 ? trxIndex : session.activeOrderPage;
              const view = renderOrderView(session.activeOrderIds, session.activeOrderPage);
              safeEdit(chatId, messageId, view.text, view.keyboard, 'HTML');
          } else {
              // Fallback jika sesi sudah tertutup (misal user kembali ke menu utama)
              const view = renderOrderView([myTrx], 0);
              safeEdit(chatId, messageId, view.text, view.keyboard, 'HTML');
          }
        }
    } catch (err) {
        console.error("AutoCheck Error:", err.message);
    }
  }, 5000);
}



bot.on('message', async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;

   // ================= PENANGKAP EDIT SALDO (ADMIN) =================
  if (msg.reply_to_message && msg.reply_to_message.text && msg.reply_to_message.text.includes('Edit Saldo User')) {
      const { ADMIN_ID } = require('./config');
      if (chatId.toString() !== ADMIN_ID.toString()) return; // Hanya admin

      const session = userSessions[userId];
      if (!session || session.action !== 'edit_saldo') return;

      const input = msg.text.trim();
      // Validasi Regex: Harus diawali + atau - lalu diikuti angka
      const match = input.match(/^([+-])(\d+)$/);
      
      if (!match) {
          bot.sendMessage(chatId, "❌ Format salah! Harus pakai awalan + atau -. Contoh: +5000", { reply_to_message_id: msg.message_id });
          return;
      }

      const operator = match[1]; // '+' atau '-'
      const jumlah = parseInt(match[2]);
      const targetId = session.targetId;

      let dbUsers = bacaDatabase();
      let targetIndex = dbUsers.findIndex(u => String(u.id) === String(targetId));
      if (targetIndex === -1) return bot.sendMessage(chatId, "User tidak ditemukan.");

      const targetUser = dbUsers[targetIndex];
      const saldoLama = targetUser.saldo;
      let saldoBaru = saldoLama;
      let pesanAdmin = '';
      let pesanUser = '';
      let keyboardUser = [];

      if (operator === '+') {
          saldoBaru = saldoLama + jumlah;
          pesanAdmin = `_Berhasil Tambah Saldo_\n\nNama: ${targetUser.nama || '-'}\nID User: ${targetId}\n\nSaldo Lama: Rp ${formatRp(saldoLama)}\nSaldo Ditambahkan: Rp ${formatRp(jumlah)}\nSaldo Baru: Rp ${formatRp(saldoBaru)}\n\nSaldo berhasil ditambahkan ke user.`;
          
          pesanUser = `_Saldo Ditambahkan!_ 🎉\n\nHalo ${targetUser.nama || 'Kak'}\nSaldo kamu berhasil ditambahkan oleh admin.\n\nJumlah Ditambahkan: Rp ${formatRp(jumlah)}\nSaldo Baru Kamu: Rp ${formatRp(saldoBaru)}\n\nSaldo sudah bisa digunakan untuk order. Terima kasih!`;
          
          keyboardUser = [
              [{ text: 'Order OTP Sekarang', callback_data: 'menu_services', style: 'primary' }],
              [
                  { text: 'Lapor Kendala', url: require('./config').CS_URL, style: 'danger' },
                  { text: 'Menu Utama', callback_data: 'menu' }
              ]
          ];
      } else {
          saldoBaru = saldoLama - jumlah;
          if (saldoBaru < 0) saldoBaru = 0; // Cegah saldo minus
          pesanAdmin = `_Berhasil Kurangi Saldo_\n\nNama: ${targetUser.nama || '-'}\nID User: ${targetId}\n\nSaldo Lama: Rp ${formatRp(saldoLama)}\nSaldo Dikurangi: Rp ${formatRp(jumlah)}\nSaldo Baru: Rp ${formatRp(saldoBaru)}\n\nSaldo berhasil dikurangi dari user.`;
          
          pesanUser = `_Saldo Dikurangi_\n\nHalo ${targetUser.nama || 'Kak'}\nSaldo kamu telah dikurangi oleh admin.\n\nJumlah Dikurangi: Rp ${formatRp(jumlah)}\nSaldo Baru Kamu: Rp ${formatRp(saldoBaru)}\n\nJika ada pertanyaan, silahkan hubungi admin.`;
          
          keyboardUser = [
              [
                  { text: 'Lapor Kendala', url: require('./config').CS_URL, style: 'danger' },
                  { text: 'Menu Utama', callback_data: 'menu' }
              ]
          ];
      }

      // Simpan perubahan
      dbUsers[targetIndex].saldo = saldoBaru;
      simpanDatabase(dbUsers);

      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      bot.deleteMessage(chatId, msg.reply_to_message.message_id).catch(() => {});

      // Kirim Notif ke Admin
      const keyboardAdmin = [
          [
              { text: 'Kembali ke Detail User', callback_data: `admin_user_detail|${targetId}|${session.page}` },
              { text: 'Tambah/Kurangi Lagi', callback_data: `admin_edit_saldo|${targetId}|${session.page}` }
          ]
      ];
      bot.sendMessage(chatId, pesanAdmin, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboardAdmin } });

      // Kirim Notif ke User
      bot.sendMessage(targetId, pesanUser, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboardUser } }).catch(()=>{});
      
      delete userSessions[userId]; // Bersihkan sesi
      return;
  }


  if (msg.reply_to_message && msg.reply_to_message.text && msg.reply_to_message.text.includes('DEPOSIT MANUAL')) {
    const nominal = parseInt(msg.text.replace(/[^0-9]/g, ''));
    if (isNaN(nominal) || nominal < 1000) {
      return bot.sendMessage(chatId, `<blockquote>❌ <b>Nominal Tidak Valid</b>\nMinimal deposit adalah Rp 1.000.</blockquote>`, { parse_mode: 'HTML', reply_to_message_id: msg.message_id });
    }

    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    bot.deleteMessage(chatId, msg.reply_to_message.message_id).catch(() => {});

    // Ambil versi dari session yang kita set tadi
    const versi = userSessions[userId]?.pendingDepoVersi || 'v1';
    
    if (versi === 'v1') {
        prosesDepositV1(chatId, userId, nominal, null, msg.from.username);
    } else {
        prosesDepositV2(chatId, userId, nominal, null, msg.from.username);
    }
  }
});



process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));
process.on('unhandledRejection', (reason) => console.error('Rejection:', reason));

console.log('☠ WARUNG NOKOS BOT ONLINE ☠');
