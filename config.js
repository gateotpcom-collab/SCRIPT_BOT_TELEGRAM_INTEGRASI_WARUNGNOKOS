module.exports = {
  // ================= 1. KREDENSIAL & TOKEN RAHASIA =================
  // Token bot Telegram yang didapat dari @BotFather
  BOT_TOKEN: '', 
  
  // API Key utama dari akun WarungNokos (digunakan untuk order OTP & Deposit V1)
  API_KEY: '', 
  
  // Token khusus deposit dari qris.zpr0.com (digunakan untuk layanan Deposit V2)
  ZAKKI_TOKEN: '', 

  // ================= 2. ENDPOINT API SERVER =================
  // Alamat URL pusat untuk layanan pemesanan nomor virtual (OTP)
  API_BASE: 'https://warungnokos.web.id/api/smscode', 
  
  // Alamat URL pusat untuk pembuatan & pengecekan tagihan QRIS (Deposit V1)
  API_DEPOSIT: 'https://warungnokos.web.id/api/deposit', 

  // ================= 3. PENGATURAN TELEGRAM & TAUTAN =================
  // Tautan channel resmi (digunakan untuk tombol "Join Channel" & syarat Force Join)
  LINK_CHANNEL: 'https://t.me/callbackwarungnokos', 
  
  // Tautan langsung ke bot ini (digunakan pada tombol "Ke Bot" di channel log transaksi)
  LINK_BUY: 'https://t.me/WarkosintegrasiBot', 
  
  // ID Channel untuk sistem Force Join (wajib diawali -100, contoh: "-1001234567890")
  CHANNEL_ID: "-", 
  
  // ID Channel khusus untuk menerima laporan otomatis user baru, deposit sukses, & OTP masuk
  LOG_CHANNEL: "-", 
  
  // ID Telegram pribadi milik Owner/Admin untuk akses /adminmenu (contoh: "8439294209")
  ADMIN_ID: "", 
  
  // Tautan website utama (muncul pada tombol "Website Order OTP" di riwayat pesanan)
  WEB_URL: "https://warungnokos.web.id", 
  
  // Tautan akun Customer Service / Owner (muncul pada tombol "Laporkan Kendala")
  CS_URL: "https://t.me/cswarungnokos", 

  // ================= 4. PENGATURAN SISTEM & BIAYA (FEE) =================
  // Status awal jalur Deposit V1 (true = Aktif, false = Nonaktif). Bisa diubah via /adminmenu
  DEPO_V1_ACTIVE: true, 
  
  // Status awal jalur Deposit V2 (true = Aktif, false = Nonaktif). Bisa diubah via /adminmenu
  DEPO_V2_ACTIVE: true, 
  
  // Biaya tambahan tetap dalam nominal Rupiah untuk deposit (isi 0 jika hanya pakai persen)
  FEE_DEPOSIT: 0, 
  
  // Persentase keuntungan (margin) yang ditambahkan ke harga dasar setiap layanan OTP (contoh: 10 berarti +10%)
  FEE_PERCENT: 0, 
  
  // Persentase biaya admin yang dibebankan ke user saat melakukan deposit (contoh: 5 berarti +5%)
  FEE_DEPOSIT_PERCENT: 5 
};
