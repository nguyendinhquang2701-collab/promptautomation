import React, { useState, useEffect, useRef } from 'react';
import { AI_PROVIDERS, ProviderConfig, loadAIProviders } from '../services/geminiService';
import { SpeedMode } from '../types';

const safeStorageGet = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};

const readStoredArray = <T,>(key: string): T[] => {
  const raw = safeStorageGet(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
};

interface HeaderProps {
  isOperationActive?: boolean;
}

const Header: React.FC<HeaderProps> = ({ isOperationActive = false }) => {
  const [isKeyManagerOpen, setIsKeyManagerOpen] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keyCount, setKeyCount] = useState(0);

  const [provider, setProvider] = useState<string>('gemini');
  const [speedMode, setSpeedMode] = useState<SpeedMode>('fast');
  const [isSpeedDropdownOpen, setIsSpeedDropdownOpen] = useState(false);
  const [isProviderDropdownOpen, setIsProviderDropdownOpen] = useState(false);
  const [providersState, setProvidersState] = useState<Record<string, ProviderConfig>>(AI_PROVIDERS);
  
  const [isAgreed, setIsAgreed] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('https://api.openai.com/v1');
  const [customModelId, setCustomModelId] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');

  const dropdownRef = useRef<HTMLDivElement>(null);
  const providerDropdownRef = useRef<HTMLDivElement>(null);
  const speedDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const savedProvider = safeStorageGet('app1_ai_provider') || 'gemini';
    const activeProvider = AI_PROVIDERS[savedProvider] ? savedProvider : Object.keys(AI_PROVIDERS)[0] || 'gemini';
    setProvider(activeProvider);
    const savedSpeedMode = safeStorageGet('app1_speed_mode');
    setSpeedMode(savedSpeedMode === 'ultra-max' || savedSpeedMode === 'ultra' ? savedSpeedMode : 'fast');
    
    const config = AI_PROVIDERS[activeProvider];
    if (config) {
        // 👉 Đọc Key từ LocalStorage để hiển thị lại vào Form, tự động thêm \n\n giữa các Key
        const savedKeys = readStoredArray<string>(`app1_${config.keyPrefix}_api_keys`).filter(key => typeof key === 'string');
        setKeyInput(savedKeys.join('\n\n')); 
        setKeyCount(savedKeys.length);
        if (savedKeys.length > 0) setIsAgreed(true);
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (document.getElementById('terms-modal')?.contains(event.target as Node)) return;
      if (document.getElementById('custom-ai-modal')?.contains(event.target as Node)) return;
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) setIsKeyManagerOpen(false);
      if (providerDropdownRef.current && !providerDropdownRef.current.contains(event.target as Node)) setIsProviderDropdownOpen(false);
      if (speedDropdownRef.current && !speedDropdownRef.current.contains(event.target as Node)) setIsSpeedDropdownOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsSpeedDropdownOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const handleSpeedModeChange = (mode: SpeedMode) => {
    if (isOperationActive) return;
    setSpeedMode(mode);
    setIsSpeedDropdownOpen(false);
    try { localStorage.setItem('app1_speed_mode', mode); } catch { /* storage unavailable */ }
  };

  const handleProviderChange = (pId: string) => {
    setProvider(pId);
    localStorage.setItem('app1_ai_provider', pId);
    const config = AI_PROVIDERS[pId];
    if (!config) return;
    const savedKeys = readStoredArray<string>(`app1_${config.keyPrefix}_api_keys`).filter(key => typeof key === 'string');
    setKeyInput(savedKeys.join('\n\n'));
    setKeyCount(savedKeys.length);
    setIsProviderDropdownOpen(false);
  };

  // 👉 THUẬT TOÁN AUTO-HEAL: Nối xương Key gãy & Cắt bằng dòng trống
  const handleSaveKeys = () => {
    if (!isAgreed) return; 
    
    // 1. Tách chuỗi dựa trên 1 (hoặc nhiều) dòng trống (\n\n)
    const rawKeys = keyInput.split(/\n\s*\n/);
    
    // 2. Với mỗi cục Key lấy được, xóa SẠCH mọi khoảng trắng, dấu xuống dòng bên trong nó
    const keys = rawKeys
        .map(k => k.replace(/\s+/g, '')) 
        .filter(k => k.length > 0);

    const config = AI_PROVIDERS[provider];
    localStorage.setItem(`app1_${config.keyPrefix}_api_keys`, JSON.stringify(keys));
    setKeyCount(keys.length);
    setIsKeyManagerOpen(false);
  };

  const handleSaveCustomModel = () => {
      if (!customName || !customModelId || !customBaseUrl) {
          alert("Vui lòng điền đủ Tên hiển thị, Mã Model và Link API Server!");
          return;
      }
      
      let normalizedBaseUrl: string;
      try {
          const parsed = new URL(customBaseUrl.trim());
          const localDevHost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
          if (parsed.protocol !== 'https:' && !(localDevHost && parsed.protocol === 'http:')) {
              alert('Vì an toàn API Key, Link API phải dùng HTTPS (HTTP chỉ được phép với localhost khi phát triển).');
              return;
          }
          if (parsed.username || parsed.password) {
              alert('Link API không được chứa tên đăng nhập hoặc mật khẩu.');
              return;
          }
          parsed.hash = '';
          normalizedBaseUrl = parsed.toString().replace(/\/+$/, '');
      } catch {
          alert('Link API Server không hợp lệ. Ví dụ: https://api.example.com/v1');
          return;
      }

      const newId = `custom_${Date.now()}`;
      const newConfig: ProviderConfig = {
          id: newId,
          name: customName,
          type: 'openai-compatible',
          model: customModelId,
          baseUrl: normalizedBaseUrl,
          keyPrefix: newId,
          group: '🤖 AI Tùy Chỉnh'
      };

      const existingCustoms = readStoredArray<ProviderConfig>('app1_custom_providers')
          .filter(item => item && typeof item === 'object');
      existingCustoms.push(newConfig);
      localStorage.setItem('app1_custom_providers', JSON.stringify(existingCustoms));

      if (customApiKey.trim()) {
          // Xóa khoảng trắng cho an toàn trước khi lưu
          const cleanKey = customApiKey.replace(/\s+/g, '');
          localStorage.setItem(`app1_${newId}_api_keys`, JSON.stringify([cleanKey]));
      }

      loadAIProviders();
      setProvidersState({ ...AI_PROVIDERS });
      handleProviderChange(newId);
      
      setCustomName(''); setCustomModelId(''); setCustomApiKey('');
      setShowCustomModal(false);
  };

  const handleDeleteCustomModel = (e: React.MouseEvent, idToDelete: string) => {
      e.stopPropagation(); 
      if (!window.confirm("Xóa cấu hình Model này khỏi máy?")) return;
      
      let existingCustoms = readStoredArray<ProviderConfig>('app1_custom_providers');
      existingCustoms = existingCustoms.filter((p: any) => p.id !== idToDelete);
      localStorage.setItem('app1_custom_providers', JSON.stringify(existingCustoms));
      localStorage.removeItem(`app1_${idToDelete}_api_keys`);

      loadAIProviders();
      setProvidersState({ ...AI_PROVIDERS });

      if (provider === idToDelete) {
          handleProviderChange('gemini'); 
      }
  };

  const currentConfig = providersState[provider];

  const groupedProviders = Object.values(providersState).reduce((acc, prov) => {
    if (!acc[prov.group]) acc[prov.group] = [];
    acc[prov.group].push(prov);
    return acc;
  }, {} as Record<string, ProviderConfig[]>);

  return (
    <>
      <header className="w-full py-5 px-6 border-b border-slate-800 bg-slate-950/90 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-white">
                <path d="M4.5 4.5a3 3 0 00-3 3v9a3 3 0 003 3h8.25a3 3 0 003-3v-9a3 3 0 00-3-3H4.5zM19.94 18.75l-2.69-2.69V7.94l2.69-2.69c.944-.945 2.56-.276 2.56 1.06v11.38c0 1.336-1.616 2.005-2.56 1.06z" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 to-purple-400 tracking-tight">
                  VEO 3 ENTERPRISE
                </h1>
              </div>
              <p className="text-xs text-slate-400 font-medium">Bản nội bộ</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            
            <div className="relative" ref={providerDropdownRef}>
              <button
                 onClick={() => setIsProviderDropdownOpen(!isProviderDropdownOpen)}
                 className="flex items-center justify-between gap-3 px-4 py-2.5 bg-slate-900 border border-slate-800 hover:border-slate-700 hover:bg-slate-800/50 rounded-xl text-sm font-bold text-white transition-all shadow-lg min-w-[170px]"
              >
                 <div className="flex items-center gap-2">
                    <span className="text-indigo-400">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M16.5 7.5h-9v9h9v-9z" /><path fillRule="evenodd" d="M8.25 2.25A.75.75 0 019 3v.75h2.25V3a.75.75 0 011.5 0v.75H15V3a.75.75 0 011.5 0v.75h.75a3 3 0 013 3v.75H21A.75.75 0 0121 9h-.75v2.25H21a.75.75 0 010 1.5h-.75V15H21a.75.75 0 010 1.5h-.75v.75a3 3 0 01-3 3h-.75V21a.75.75 0 01-1.5 0v-.75h-2.25V21a.75.75 0 01-1.5 0v-.75H9V21a.75.75 0 01-1.5 0v-.75h-.75a3 3 0 01-3-3v-.75H3A.75.75 0 013 15h.75v-2.25H3a.75.75 0 010-1.5h.75V9H3a.75.75 0 010-1.5h.75V6a3 3 0 013-3h.75V2.25a.75.75 0 01.75-.75zM6 6a1.5 1.5 0 011.5-1.5h9A1.5 1.5 0 0118 6v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 016 15V6z" clipRule="evenodd" /></svg>
                    </span>
                    {currentConfig?.name || 'Chọn AI'}
                 </div>
                 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-4 h-4 text-slate-500 transition-transform duration-300 ${isProviderDropdownOpen ? 'rotate-180' : ''}`}>
                   <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z" clipRule="evenodd" />
                 </svg>
              </button>

              {isProviderDropdownOpen && (
                <div className="absolute right-0 top-full mt-2 w-64 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden animate-fade-in max-h-[70vh] overflow-y-auto custom-scrollbar flex flex-col">
                   <div className="p-2 border-b border-slate-700/50">
                      <button onClick={() => { setShowCustomModal(true); setIsProviderDropdownOpen(false); }} className="w-full text-left px-4 py-2.5 bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600 hover:text-white rounded-lg text-xs font-bold transition-colors border border-indigo-500/30 text-center">
                          + THÊM MODEL TÙY CHỈNH
                      </button>
                   </div>
                   
                   {Object.entries(groupedProviders).map(([groupName, provs]) => (
                     <div key={groupName} className="mb-1 last:mb-0 border-b border-slate-700/50 last:border-0">
                       <div className="px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500 bg-slate-900/40">
                         {groupName}
                       </div>
                       {provs.map(prov => (
                         <button
                           key={prov.id}
                           onClick={() => handleProviderChange(prov.id)}
                           className={`w-full text-left px-4 py-3 text-xs font-bold transition-colors flex items-center justify-between group
                             ${provider === prov.id ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-300 hover:bg-slate-700 hover:text-white'}
                           `}
                         >
                           <span className="flex-1 truncate">{prov.name}</span>
                           
                           <div className="flex items-center gap-2">
                             {prov.id.startsWith('custom_') && (
                                <span onClick={(e) => handleDeleteCustomModel(e, prov.id)} className="text-slate-500 hover:text-red-400 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity" title="Xóa Model này">
                                   <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" /></svg>
                                </span>
                             )}
                             {provider === prov.id && (
                               <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.8)]"></span>
                             )}
                           </div>
                         </button>
                       ))}
                     </div>
                   ))}
                </div>
              )}
            </div>

            {/* 👉 MỞ RỘNG BỀ NGANG POPUP W-96 */}
            <div className="relative" ref={speedDropdownRef}>
              <button
                type="button"
                onClick={() => !isOperationActive && setIsSpeedDropdownOpen(value => !value)}
                disabled={isOperationActive}
                aria-haspopup="menu"
                aria-expanded={isSpeedDropdownOpen}
                className={`flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2.5 text-xs font-bold text-white shadow-lg transition-colors hover:border-slate-700 hover:bg-slate-800 ${isOperationActive ? 'cursor-not-allowed opacity-60' : ''}`}
                title="Chọn tốc độ xử lý"
              >
                <span className={speedMode === 'ultra-max' ? 'text-amber-400' : speedMode === 'ultra' ? 'text-fuchsia-400' : 'text-indigo-400'}>⚡</span>
                <span>{speedMode === 'ultra-max' ? 'Ultra Max' : speedMode === 'ultra' ? 'Ultra' : 'Fast'}</span>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`h-4 w-4 text-slate-500 transition-transform ${isSpeedDropdownOpen ? 'rotate-180' : ''}`}>
                  <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z" clipRule="evenodd" />
                </svg>
              </button>
              {isSpeedDropdownOpen && (
                <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-xl border border-slate-700 bg-slate-800 p-1 shadow-2xl">
                  <button type="button" role="menuitem" onClick={() => handleSpeedModeChange('fast')} className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${speedMode === 'fast' ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-300 hover:bg-slate-700'}`}>
                    <span className="mt-0.5 text-indigo-400">{speedMode === 'fast' ? '✓' : '○'}</span>
                    <span><span className="block text-xs font-bold">Fast</span><span className="block text-[10px] text-slate-400">1 luồng · tương thích API cao</span></span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => handleSpeedModeChange('ultra')} className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${speedMode === 'ultra' ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'text-slate-300 hover:bg-slate-700'}`}>
                    <span className="mt-0.5 text-fuchsia-400">{speedMode === 'ultra' ? '✓' : '○'}</span>
                    <span><span className="block text-xs font-bold">Ultra</span><span className="block text-[10px] text-slate-400">Tối đa 2 luồng · cùng một API key</span></span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => handleSpeedModeChange('ultra-max')} className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${speedMode === 'ultra-max' ? 'bg-amber-500/20 text-amber-300' : 'text-slate-300 hover:bg-slate-700'}`}>
                    <span className="mt-0.5 text-amber-400">{speedMode === 'ultra-max' ? '✓' : '○'}</span>
                    <span><span className="block text-xs font-bold">Ultra Max</span><span className="block text-[10px] text-slate-400">Tối đa 4 luồng · dành cho API khỏe</span></span>
                  </button>
                </div>
              )}
            </div>

            <div className="relative" ref={dropdownRef}>
              <button 
                onClick={() => setIsKeyManagerOpen(!isKeyManagerOpen)}
                className={`
                  flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-all shadow-lg
                  ${keyCount > 0 
                    ? 'bg-slate-900 border-indigo-500/50 text-indigo-300 hover:bg-slate-800' 
                    : 'bg-red-500/10 border-red-500/50 text-red-400 animate-pulse'}
                `}
              >
                <span className="text-lg">🔑</span>
                <div className="flex flex-col items-start text-left">
                  <span className="text-[10px] uppercase font-bold tracking-widest text-slate-500 leading-none truncate max-w-[80px]">
                    {currentConfig ? currentConfig.group : 'API'} Key
                  </span>
                  <span className="text-sm font-bold leading-tight">Đang có {keyCount} Key</span>
                </div>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-4 h-4 ml-2 transition-transform ${isKeyManagerOpen ? 'rotate-180' : ''}`}>
                  <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z" clipRule="evenodd" />
                </svg>
              </button>

              {isKeyManagerOpen && (
                <div className="absolute right-0 top-full mt-3 w-96 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 animate-fade-in-up z-50">
                  <h3 className="text-sm font-bold text-white mb-1">
                    Quản Lý Danh Sách Key {currentConfig?.group}
                  </h3>
                  {/* 👉 HƯỚNG DẪN MỚI */}
                  <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                    Mỗi Key cách nhau <b>1 dòng trống</b> (Enter 2 lần). Hệ thống sẽ tự động nối các Key bị copy gãy dòng.
                  </p>
                  
                  {/* 👉 Ô TEXTAREA CAO HƠN */}
                  <textarea 
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    className="w-full h-40 bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs font-mono text-emerald-400 focus:border-indigo-500 outline-none resize-none mb-3 tracking-wider leading-relaxed custom-scrollbar"
                    placeholder={currentConfig?.type === 'gemini' ? `AIzaSy...\n\nAIzaSy...` : `sk-...\n\nsk-...`}
                    spellCheck="false"
                  />
                  
                  <div className="flex items-start gap-2 mb-4">
                    <input 
                      type="checkbox" 
                      id="terms-checkbox" 
                      checked={isAgreed}
                      onChange={(e) => setIsAgreed(e.target.checked)}
                      className="mt-0.5 shrink-0 w-3.5 h-3.5 rounded border-slate-700 text-indigo-600 focus:ring-indigo-600 bg-slate-950 cursor-pointer"
                    />
                    <label htmlFor="terms-checkbox" className="text-[10px] text-slate-400 leading-tight cursor-pointer select-none">
                      Tôi đã hiểu và đồng ý với <button type="button" onClick={(e) => { e.preventDefault(); setShowTerms(true); }} className="text-indigo-400 font-bold hover:underline transition-all">Điều khoản bảo mật & Miễn trừ trách nhiệm</button>
                    </label>
                  </div>

                  <button 
                    onClick={handleSaveKeys} 
                    disabled={!isAgreed}
                    className={`
                      w-full font-bold py-3 rounded-xl transition-all flex items-center justify-center gap-2
                      ${isAgreed 
                        ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20' 
                        : 'bg-slate-800 text-slate-500 cursor-not-allowed'}
                    `}
                  >
                    Lưu Danh Sách
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* MODAL THÊM AI TÙY CHỈNH */}
      {showCustomModal && (
        <div id="custom-ai-modal" className="fixed inset-0 bg-slate-950/90 backdrop-blur-md z-[200] flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-lg w-full p-8 shadow-2xl relative animate-fade-in-up">
            <button onClick={() => setShowCustomModal(false)} className="absolute top-6 right-6 text-slate-500 hover:text-white transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
            
            <div className="flex items-center gap-4 mb-6">
               <div className="w-12 h-12 bg-indigo-500/10 rounded-xl flex items-center justify-center border border-indigo-500/30 text-indigo-400">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
               </div>
               <div>
                 <h2 className="text-xl font-black text-white">Thêm AI Tùy Chỉnh</h2>
                 <p className="text-slate-400 text-xs">Cấu hình kết nối bất kỳ AI nào hỗ trợ chuẩn OpenAI API.</p>
               </div>
            </div>

            <div className="space-y-5">
               <div>
                  <label className="text-[11px] uppercase font-bold text-slate-400 tracking-wider block mb-2">Tên hiển thị trong Menu</label>
                  <input type="text" value={customName} onChange={e=>setCustomName(e.target.value)} placeholder="VD: Claude 3.5 qua OpenRouter..." className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-white focus:outline-none focus:border-indigo-500 transition-colors text-sm font-medium"/>
               </div>
               
               <div>
                  <label className="text-[11px] uppercase font-bold text-slate-400 tracking-wider block mb-2 flex justify-between">
                     <span>Link Máy Chủ API (Base URL)</span>
                     <span className="text-indigo-400 lowercase font-mono">/chat/completions</span>
                  </label>
                  <input type="text" value={customBaseUrl} onChange={e=>setCustomBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-emerald-400 focus:outline-none focus:border-indigo-500 transition-colors font-mono text-sm"/>
                  <p className="text-[10px] text-slate-500 mt-1.5 italic">Không điền /chat/completions ở cuối link.</p>
               </div>

               <div>
                  <label className="text-[11px] uppercase font-bold text-slate-400 tracking-wider block mb-2">Mã Model (Model ID)</label>
                  <input type="text" value={customModelId} onChange={e=>setCustomModelId(e.target.value)} placeholder="VD: anthropic/claude-3.5-sonnet" className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-amber-400 focus:outline-none focus:border-indigo-500 transition-colors font-mono text-sm"/>
               </div>

               <div>
                  <label className="text-[11px] uppercase font-bold text-slate-400 tracking-wider block mb-2">API Key (Khóa bí mật)</label>
                  <input type="password" value={customApiKey} onChange={e=>setCustomApiKey(e.target.value)} placeholder="sk-or-v1-..." className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-white focus:outline-none focus:border-indigo-500 transition-colors font-mono text-sm tracking-wider"/>
                  <p className="text-[10px] text-amber-400/90 mt-1.5">Key được lưu cục bộ nhưng không mã hóa, và sẽ được gửi tới đúng Link API ở trên. Chỉ dùng endpoint HTTPS mà bạn tin cậy.</p>
               </div>
            </div>

            <button onClick={handleSaveCustomModel} className="mt-8 w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-indigo-500/20 flex items-center justify-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" /></svg>
              Lưu cấu hình và Sử dụng ngay
            </button>
          </div>
        </div>
      )}

      {showTerms && (
        <div id="terms-modal" className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-md w-full p-6 shadow-2xl relative animate-fade-in-up">
            <button onClick={() => setShowTerms(false)} className="absolute top-5 right-5 text-slate-500 hover:text-white transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
            
            <div className="flex items-center gap-3 mb-5">
               <div className="w-10 h-10 bg-amber-500/10 rounded-full flex items-center justify-center border border-amber-500/20 text-amber-500">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z" clipRule="evenodd" /></svg>
               </div>
               <h2 className="text-lg font-black text-white">ĐIỀU KHOẢN BẢO MẬT</h2>
            </div>

            <div className="space-y-4 text-xs text-slate-300 leading-relaxed max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
              <p><strong className="text-emerald-400 block mb-1">1. Lưu cục bộ trên thiết bị:</strong> API Key được lưu trong LocalStorage của trình duyệt để tái sử dụng. Dữ liệu này <b>không được mã hóa</b>; hãy dùng key riêng, giới hạn quota và quyền truy cập.</p>
              <p><strong className="text-indigo-400 block mb-1">2. Dữ liệu gửi tới nhà cung cấp AI:</strong> Key, prompt và nội dung tham chiếu được gửi trực tiếp tới nhà cung cấp/endpoint bạn chọn để xử lý. Hãy kiểm tra chính sách dữ liệu của họ trước khi dùng.</p>
              <p><strong className="text-red-400 block mb-1">3. Rủi ro trên trình duyệt:</strong> Mã chạy cùng website, lỗ hổng XSS hoặc tiện ích mở rộng có quyền phù hợp có thể đọc LocalStorage. Không nhập key dùng chung của công ty.</p>
              <p><strong className="text-amber-400 block mb-1">4. Trách nhiệm sử dụng:</strong> Bạn chịu trách nhiệm chọn endpoint đáng tin cậy và thu hồi key ngay khi nghi ngờ bị lộ.</p>
            </div>

            <button 
              onClick={() => { setIsAgreed(true); setShowTerms(false); }} 
              className="mt-6 w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl transition-all shadow-lg shadow-emerald-500/20"
            >
              Tôi đã đọc rõ & Đồng ý
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default Header;
