import React, { useState, useEffect } from 'react';

interface DashboardProps {
  onBack: () => void;
}

const FIREBASE_DB_URL = "https://planning-with-ai-367b2-default-rtdb.asia-southeast1.firebasedatabase.app/veo3_stats.json";
const LICENSE_DB_URL = "https://planning-with-ai-367b2-default-rtdb.asia-southeast1.firebasedatabase.app/veo3_licenses.json";

// 👉 THUẬT TOÁN BĂM MẬT KHẨU (CHỐNG LỘ CODE FRONTEND)
const hashPassword = (str: string) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0; 
  }
  return hash;
};

const Dashboard: React.FC<DashboardProps> = ({ onBack }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [activeTab, setActiveTab] = useState<'stats' | 'license'>('stats');

  // -- STATE STATS --
  const [history, setHistory] = useState<any[]>([]);

  // -- STATE LICENSE --
  const [licenses, setLicenses] = useState<Record<string, any>>({});
  const [prefix, setPrefix] = useState('PRO');
  const [duration, setDuration] = useState(30 * 24 * 60 * 60 * 1000); // Mặc định 30 ngày

  const loadHistory = async () => {
    try {
      const res = await fetch(FIREBASE_DB_URL);
      const data = await res.json();
      if (data) setHistory(Object.values(data));
    } catch(e) {}
  };

  const loadLicenses = async () => {
    try {
      const res = await fetch(LICENSE_DB_URL);
      const data = await res.json();
      if (data) setLicenses(data);
    } catch(e) {}
  };

  useEffect(() => {
    if (!isAuthenticated) return;
    loadHistory(); 
    loadLicenses();
  }, [isAuthenticated, activeTab]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    // 👉 SO SÁNH MÃ BĂM THAY VÌ SO SÁNH CHỮ (Mã băm của 270201 là -1605559816)
    if (hashPassword(password) === -1605559816) { 
      setIsAuthenticated(true); 
      setError(false); 
    } else { 
      setError(true); 
      setPassword(''); 
    }
  };

  const handleGenerateKey = async () => {
    const randomStr = Math.random().toString(36).substring(2, 8).toUpperCase();
    const newKey = `${prefix}-${randomStr}`;
    
    await fetch(`https://planning-with-ai-367b2-default-rtdb.asia-southeast1.firebasedatabase.app/veo3_licenses/${newKey}.json`, {
      method: 'PUT',
      body: JSON.stringify({
        durationMs: duration,
        createdAt: Date.now(),
        deviceId: null, 
        expiresAt: null
      })
    });
    alert(`🎉 Tạo mã bản quyền thành công:\n\n${newKey}\n\nHãy copy mã này gửi cho khách hàng!`);
    loadLicenses();
  };

  const handleDeleteKey = async (key: string) => {
    if(window.confirm(`Xóa vĩnh viễn Key [${key}]? Khách hàng đang dùng mã này sẽ bị văng ra ngoài ngay lập tức!`)) {
      await fetch(`https://planning-with-ai-367b2-default-rtdb.asia-southeast1.firebasedatabase.app/veo3_licenses/${key}.json`, { method: 'DELETE' });
      loadLicenses();
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="w-full flex items-center justify-center min-h-[100vh] animate-fade-in-up px-4">
        <div className="bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-2xl w-full max-w-sm text-center relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-emerald-500 to-teal-500"></div>
          <div className="w-16 h-16 bg-slate-950 border border-slate-800 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner">
            <span className="text-2xl">🛡️</span>
          </div>
          <h2 className="text-xl font-bold text-white mb-2">HỆ THỐNG QUẢN TRỊ</h2>
          <form onSubmit={handleLogin} className="flex flex-col gap-4 mt-6">
            <input 
              type="password" 
              value={password} 
              onChange={(e) => { setPassword(e.target.value); setError(false); }} 
              placeholder="Nhập khóa quản trị..." 
              className="w-full bg-slate-950 border border-slate-700 rounded-xl p-4 text-center text-white focus:outline-none focus:border-emerald-500 tracking-widest text-lg transition-all"
            />
            {error && <p className="text-red-400 text-xs">⚠️ Khóa quản trị không hợp lệ!</p>}
            <button type="submit" className="w-full px-4 py-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-bold shadow-lg shadow-emerald-500/20 transition-all">Truy cập Admin Panel</button>
            <button type="button" onClick={onBack} className="text-slate-500 hover:text-white transition-colors text-xs underline mt-2">Quay lại Website</button>
          </form>
        </div>
      </div>
    );
  }

  const filteredStats = history.reduce((acc, r) => ({ totalInput: acc.totalInput + (r.input || 0), totalOutput: acc.totalOutput + (r.output || 0) }), { totalInput: 0, totalOutput: 0 });

  return (
    <div className="w-full max-w-6xl mx-auto pb-20 mt-8 px-4 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-8 border-b border-slate-800 pb-6 gap-4">
        <div>
          <h2 className="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-teal-400">DASHBOARD ADMIN</h2>
          <p className="text-sm text-slate-400 mt-1">Trạm kiểm soát máy chủ & License Khách hàng</p>
        </div>
        <button onClick={onBack} className="px-6 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-bold transition-all shadow-lg">Đóng Panel &times;</button>
      </div>

      <div className="flex gap-4 mb-8 bg-slate-900/50 p-2 rounded-2xl w-fit border border-slate-800">
        <button onClick={() => setActiveTab('stats')} className={`px-6 py-2.5 rounded-xl font-bold text-sm transition-all ${activeTab === 'stats' ? 'bg-indigo-600 text-white shadow-lg' : 'bg-transparent text-slate-400 hover:text-white'}`}>📊 Thống Kê Token</button>
        <button onClick={() => setActiveTab('license')} className={`px-6 py-2.5 rounded-xl font-bold text-sm transition-all ${activeTab === 'license' ? 'bg-emerald-600 text-white shadow-lg' : 'bg-transparent text-slate-400 hover:text-white'}`}>🔑 Cấp Phát Bản Quyền</button>
      </div>

      {activeTab === 'stats' && (
         <div className="grid grid-cols-2 gap-6 mb-8 animate-fade-in-up">
            <div className="bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-xl">
              <p className="text-slate-400 text-sm font-bold uppercase tracking-widest mb-2">Tổng Input Khách Hàng</p>
              <p className="text-5xl font-black text-white">{filteredStats.totalInput.toLocaleString()}</p>
            </div>
            <div className="bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-xl">
              <p className="text-slate-400 text-sm font-bold uppercase tracking-widest mb-2">Tổng Output (Gen AI)</p>
              <p className="text-5xl font-black text-indigo-400">{filteredStats.totalOutput.toLocaleString()}</p>
            </div>
         </div>
      )}

      {activeTab === 'license' && (
         <div className="space-y-8 animate-fade-in-up">
            <div className="bg-slate-900 border border-slate-800 p-8 rounded-3xl flex flex-wrap gap-6 items-end shadow-xl relative overflow-hidden">
               <div className="absolute top-0 right-0 p-6 opacity-5 text-6xl">⚙️</div>
               <div className="relative z-10">
                 <label className="text-xs text-slate-400 font-bold block mb-2 uppercase tracking-wider">Tiền tố mã (Tùy chọn)</label>
                 <input type="text" value={prefix} onChange={e=>setPrefix(e.target.value)} placeholder="VD: VIP" className="bg-slate-950 border border-slate-700 focus:border-emerald-500 rounded-xl px-4 py-3 text-white font-mono uppercase w-40 outline-none transition-all" />
               </div>
               <div className="relative z-10">
                 <label className="text-xs text-slate-400 font-bold block mb-2 uppercase tracking-wider">Thời hạn cấp phép</label>
                 <select value={duration} onChange={e=>setDuration(Number(e.target.value))} className="bg-slate-950 border border-slate-700 focus:border-emerald-500 rounded-xl px-4 py-3 text-white outline-none cursor-pointer transition-all appearance-none min-w-[200px]">
                    <option value={1000 * 60 * 60}>⏱️ Dùng thử 1 Giờ</option>
                    <option value={1000 * 60 * 60 * 24 * 7}>📅 7 Ngày</option>
                    <option value={1000 * 60 * 60 * 24 * 30}>📅 1 Tháng (30 Ngày)</option>
                    <option value={1000 * 60 * 60 * 24 * 90}>📅 3 Tháng (90 Ngày)</option>
                    <option value={1000 * 60 * 60 * 24 * 365}>🏆 1 Năm (365 Ngày)</option>
                    {/* 👉 SỬA ĐỔI: THÊM DÒNG VĨNH VIỄN */}
                    <option value={-1}>💎 Vĩnh viễn (Trọn đời)</option>
                 </select>
               </div>
               <button onClick={handleGenerateKey} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-8 py-3 rounded-xl shadow-lg shadow-emerald-500/20 transition-all relative z-10 flex items-center gap-2">
                 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" /></svg>
                 TẠO MÃ BẢN QUYỀN
               </button>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-xl">
               <div className="overflow-x-auto">
                 <table className="w-full text-left whitespace-nowrap">
                    <thead className="bg-slate-950 text-slate-400 text-[11px] uppercase tracking-widest">
                       <tr>
                          <th className="px-6 py-5 font-bold">Mã License Key</th>
                          <th className="px-6 py-5 font-bold">Trạng Thái</th>
                          <th className="px-6 py-5 font-bold">Hardware Fingerprint</th>
                          <th className="px-6 py-5 font-bold">Hạn Sử Dụng</th>
                          <th className="px-6 py-5 font-bold text-right">Quản Lý</th>
                       </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50 text-sm">
                       {Object.entries(licenses).reverse().map(([key, data]) => {
                          // 👉 SỬA ĐỔI: THÊM KIỂM TRA isPermanent
                          const isPermanent = data.durationMs === -1;
                          const isUsed = !!data.deviceId;
                          const isExpired = isUsed && !isPermanent && Date.now() > data.expiresAt;
                          return (
                             <tr key={key} className="hover:bg-slate-800/30 transition-colors">
                                <td className="px-6 py-4 font-mono text-emerald-400 font-bold">{key}</td>
                                <td className="px-6 py-4">
                                  {isExpired ? <span className="bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 w-fit"><span className="w-1.5 h-1.5 rounded-full bg-red-500"></span> Hết hạn</span>
                                  : isUsed ? <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 w-fit"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Đang chạy</span>
                                  : <span className="bg-slate-800 border border-slate-700 text-slate-300 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 w-fit"><span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span> Tồn kho</span>}
                                </td>
                                <td className="px-6 py-4 text-slate-500 font-mono text-[11px] bg-slate-950/30">{data.deviceId || 'Chưa gắn thiết bị'}</td>
                                <td className="px-6 py-4 text-slate-300 font-medium">
                                  {/* 👉 SỬA ĐỔI: HIỂN THỊ UI VĨNH VIỄN */}
                                  {isPermanent 
                                    ? <span className="text-fuchsia-400 font-bold tracking-widest text-xs">∞ VĨNH VIỄN</span>
                                    : (isUsed ? new Date(data.expiresAt).toLocaleString('vi-VN', {hour: '2-digit', minute:'2-digit', day: '2-digit', month: '2-digit', year: 'numeric'}) : `Đóng gói ${(data.durationMs / 86400000)} Ngày`)
                                  }
                                </td>
                                <td className="px-6 py-4 text-right">
                                   <button onClick={() => handleDeleteKey(key)} className="text-red-500 hover:text-white hover:bg-red-500 px-3 py-1.5 rounded-lg text-xs font-bold transition-all border border-transparent hover:border-red-600">Thu hồi</button>
                                </td>
                             </tr>
                          )
                       })}
                       {Object.keys(licenses).length === 0 && (
                          <tr><td colSpan={5} className="text-center py-10 text-slate-500 italic">Chưa có mã bản quyền nào được tạo.</td></tr>
                       )}
                    </tbody>
                 </table>
               </div>
            </div>
         </div>
      )}
    </div>
  );
};

export default Dashboard;
