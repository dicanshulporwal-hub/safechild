import React, { createContext, useContext, useState, ReactNode } from 'react';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  text: string;
}

interface ToastContextType {
  showToast: (text: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
}

const ToastContext = createContext<ToastContextType>({
  showToast: () => {},
});

export const useToast = () => useContext(ToastContext);

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = (text: string, type: 'success' | 'error' | 'info' | 'warning' = 'success') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, text }]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Fixed Toast Container */}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            onClick={() => removeToast(toast.id)}
            className={`pointer-events-auto p-3.5 rounded-xl shadow-xl border text-sm font-medium flex items-center justify-between gap-3 animate-slideUp transition-all cursor-pointer ${
              toast.type === 'success'
                ? 'bg-slate-900 border-emerald-500/40 text-emerald-300'
                : toast.type === 'error'
                ? 'bg-slate-900 border-rose-500/40 text-rose-300'
                : toast.type === 'warning'
                ? 'bg-slate-900 border-amber-500/40 text-amber-300'
                : 'bg-slate-900 border-indigo-500/40 text-indigo-300'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <span>{toast.type === 'success' ? '✓' : toast.type === 'error' ? '⚠️' : toast.type === 'warning' ? '⚡' : 'ℹ️'}</span>
              <span>{toast.text}</span>
            </div>
            <button className="text-slate-500 hover:text-slate-300 text-xs">✕</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
