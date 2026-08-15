const fs = require('fs');
const path = require('path');

// Dataset for Hatacco Premium Paint (Hatacco nano) with all packaging weights mapped from screenshots
const products = [
  // --- BỘT BẢ, NHŨ VÀNG, KEO PHỦ & CHỐNG THẤM ĐẶC BIỆT ---
  { code: 'EMP-01', name: 'Chống thấm sàn chuyên dụng', brand: 'Hatacco nano', priceThung: 1075260, priceLon: 1075260, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '', weightLon: '4kg', weightHop: '', weightBao: '9kg', weightTui: '' }, // Bộ 13kg (Bao 9kg + Lon 4kg) giá 1,075,260
  { code: 'EMP-02', name: 'Nhũ vàng 24K', brand: 'Hatacco nano', priceThung: 0, priceLon: 2708800, priceHop: 600600, priceBao: 0, priceTui: 0, weightThung: '', weightLon: '5kg', weightHop: '1kg', weightBao: '', weightTui: '' },
  { code: 'M-03', name: 'Keo chống thấm trong suốt', brand: 'Hatacco nano', priceThung: 5126940, priceLon: 1466010, priceHop: 338520, priceBao: 0, priceTui: 0, weightThung: '18kg', weightLon: '5kg', weightHop: '1kg', weightBao: '', weightTui: '' },
  { code: 'M-04', name: 'Keo chống thấm màu lộ thiên', brand: 'Hatacco nano', priceThung: 5399940, priceLon: 1547910, priceHop: 393120, priceBao: 0, priceTui: 0, weightThung: '18kg', weightLon: '5kg', weightHop: '1kg', weightBao: '', weightTui: '' },
  { code: 'M-05', name: 'Keo phủ bóng bề mặt sơn', brand: 'Hatacco nano', priceThung: 0, priceLon: 1010127, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '', weightLon: '4kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'EMP-06', name: 'Bột bả nội thất cao cấp', brand: 'Hatacco nano', priceThung: 0, priceLon: 0, priceHop: 0, priceBao: 519612, priceTui: 0, weightThung: '', weightLon: '', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'EMP-07', name: 'Bột bả ngoại thất cao cấp', brand: 'Hatacco nano', priceThung: 0, priceLon: 0, priceHop: 0, priceBao: 574212, priceTui: 0, weightThung: '', weightLon: '', weightHop: '', weightBao: '', weightTui: '' },

  // --- SƠN GIẢ ĐÁ ---
  { code: 'M-08', name: 'Sơn giả đá vảy (bả & phun)', brand: 'Hatacco nano', priceThung: 5045040, priceLon: 1138410, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '18kg', weightLon: '4kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-09', name: 'Sơn giả đá hoa cương (phun)', brand: 'Hatacco nano', priceThung: 6109740, priceLon: 1411410, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '18kg', weightLon: '4kg', weightHop: '', weightBao: '', weightTui: '' },

  // --- SƠN KINH TẾ (Nội ngoại thất & Lót) ---
  { code: 'M-10', name: 'Sơn lót chống kiềm siêu mịn nội thất KT', brand: 'Hatacco nano', priceThung: 785623, priceLon: 254534, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '22kg', weightLon: '6kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-11', name: 'Sơn siêu mịn nội thất KT', brand: 'Hatacco nano', priceThung: 785623, priceLon: 270341, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '22kg', weightLon: '6kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-12', name: 'Sơn lót chống kiềm siêu mịn ngoại thất KT', brand: 'Hatacco nano', priceThung: 1113223, priceLon: 498498, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '22kg', weightLon: '6kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-13', name: 'Sơn siêu mịn ngoại thất KT', brand: 'Hatacco nano', priceThung: 1108380, priceLon: 498498, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '22kg', weightLon: '6kg', weightHop: '', weightBao: '', weightTui: '' },

  // --- SƠN NỘI NGOẠI THẤT CAO CẤP ---
  { code: 'M-14', name: 'Sơn siêu mịn ngoại thất cao cấp', brand: 'Hatacco nano', priceThung: 1979867, priceLon: 580382, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '21kg', weightLon: '6kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-15', name: 'Sơn lót chống kiềm nội thất cao cấp', brand: 'Hatacco nano', priceThung: 1611415, priceLon: 482129, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '21kg', weightLon: '6kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-16', name: 'Sơn lót chống kiềm nội thất đặc biệt', brand: 'Hatacco nano', priceThung: 2157415, priceLon: 653109, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '21kg', weightLon: '6kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-17', name: 'Sơn bóng mờ nội thất cao cấp', brand: 'Hatacco nano', priceThung: 2818452, priceLon: 843455, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '18kg', weightLon: '5kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-18', name: 'Sơn siêu bóng nội thất cao cấp', brand: 'Hatacco nano', priceThung: 3146052, priceLon: 957324, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '18kg', weightLon: '5kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-19', name: 'Sơn men sứ nội thất cao cấp 9in1', brand: 'Hatacco nano', priceThung: 3419052, priceLon: 1036352, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '18kg', weightLon: '5kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-20', name: 'Sơn siêu bóng nội thất đặc biệt', brand: 'Hatacco nano', priceThung: 3692052, priceLon: 1213654, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '18kg', weightLon: '5kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-21', name: 'Sơn siêu trắng trần nội thất cao cấp', brand: 'Hatacco nano', priceThung: 1782690, priceLon: 594230, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '21kg', weightLon: '6kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-22', name: 'Sơn siêu trắng trần nội thất đặc biệt', brand: 'Hatacco nano', priceThung: 2328690, priceLon: 804755, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '21kg', weightLon: '6kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-23', name: 'Sơn lót chống kiềm ngoại thất cao cấp', brand: 'Hatacco nano', priceThung: 2305611, priceLon: 679677, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '20kg', weightLon: '5.5kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-24', name: 'Sơn lót chống kiềm ngoại thất đặc biệt', brand: 'Hatacco nano', priceThung: 2851611, priceLon: 828588, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '20kg', weightLon: '5.5kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-25', name: 'Sơn chống thấm màu đa năng', brand: 'Hatacco nano', priceThung: 3726450, priceLon: 1099557, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '18kg', weightLon: '5kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-26', name: 'Sơn siêu bóng ngoại thất cao cấp', brand: 'Hatacco nano', priceThung: 4523610, priceLon: 1311148, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '18kg', weightLon: '5kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-27', name: 'Sơn men sứ ngoại thất cao cấp 10in1', brand: 'Hatacco nano', priceThung: 4796610, priceLon: 1435117, priceHop: 352427, priceBao: 0, priceTui: 0, weightThung: '18kg', weightLon: '5kg', weightHop: '1kg', weightBao: '', weightTui: '' },
  { code: 'M-28', name: 'Sơn siêu bóng ngoại thất đặc biệt', brand: 'Hatacco nano', priceThung: 5069610, priceLon: 1561729, priceHop: 413349, priceBao: 0, priceTui: 0, weightThung: '18kg', weightLon: '5kg', weightHop: '1kg', weightBao: '', weightTui: '' },
  { code: 'M-29', name: 'Sơn bóng mờ ngoại thất cao cấp', brand: 'Hatacco nano', priceThung: 3726450, priceLon: 1099557, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '18kg', weightLon: '5kg', weightHop: '', weightBao: '', weightTui: '' },
  { code: 'M-30', name: 'Sơn chống thấm trộn xi măng tỉ lệ (1:1)', brand: 'Hatacco nano', priceThung: 2843208, priceLon: 814812, priceHop: 0, priceBao: 0, priceTui: 0, weightThung: '19kg', weightLon: '5kg', weightHop: '', weightBao: '', weightTui: '' }
];

function run() {
  try {
    const XLSX = require('xlsx');
    writeExcel(XLSX);
  } catch (err) {
    console.log("XLSX is not installed. Installing it now...");
    const { execSync } = require('child_process');
    execSync('npm install xlsx', { stdio: 'inherit' });
    const XLSX = require('xlsx');
    writeExcel(XLSX);
  }
}

function writeExcel(XLSX) {
  const headers = [['Mã SP', 'Tên sản phẩm', 'Hãng sơn', 'Giá Thùng', 'Giá Lon', 'Giá Hộp', 'Giá Bao', 'Giá Túi', 'KL Thùng', 'KL Lon', 'KL Hộp', 'KL Bao', 'KL Túi']];
  const rows = products.map(p => [
    p.code,
    p.name,
    p.brand,
    p.priceThung,
    p.priceLon,
    p.priceHop,
    p.priceBao,
    p.priceTui,
    p.weightThung || '',
    p.weightLon || '',
    p.weightHop || '',
    p.weightBao || '',
    p.weightTui || ''
  ]);

  const sheetData = headers.concat(rows);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(sheetData);

  ws['!cols'] = [
    { wch: 15 }, // Mã SP
    { wch: 45 }, // Tên sản phẩm
    { wch: 15 }, // Hãng sơn
    { wch: 15 }, // Giá Thùng
    { wch: 15 }, // Giá Lon
    { wch: 15 }, // Giá Hộp
    { wch: 15 }, // Giá Bao
    { wch: 15 }, // Giá Túi
    { wch: 12 }, // KL Thùng
    { wch: 12 }, // KL Lon
    { wch: 12 }, // KL Hộp
    { wch: 12 }, // KL Bao
    { wch: 12 }  // KL Túi
  ];

  XLSX.utils.book_append_sheet(wb, ws, "Danh Sach San Pham");
  
  const destPath = path.join(__dirname, 'Danh_Sach_San_Pham_Hatacco.xlsx');
  XLSX.writeFile(wb, destPath);
  console.log(`Successfully created Excel file at: ${destPath}`);
}

run();
