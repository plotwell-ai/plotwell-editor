import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from "react";

interface ToastItem {
  id: number;
  message: string;
  type: "success" | "error" | "info";
}

interface ToastContextValue {
  toast: (message: string, type?: ToastItem["type"]) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, type: ToastItem["type"] = "success") => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <ToastMessage key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastMessage({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), 3500);
    return () => clearTimeout(timer);
  }, [item.id, onDismiss]);

  const styles: Record<ToastItem["type"], { bg: string; border: string; icon: string; dot: string }> = {
    success: {
      bg: "#111115",
      border: "#1e1e24",
      icon: "#4ade80",
      dot: "#4ade80",
    },
    error: {
      bg: "#111115",
      border: "#3f1919",
      icon: "#f87171",
      dot: "#f87171",
    },
    info: {
      bg: "#111115",
      border: "#1e1e24",
      icon: "var(--amber-light)",
      dot: "var(--amber)",
    },
  };

  const s = styles[item.type];

  const icons = {
    success: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke={s.icon} strokeWidth="1.2"/>
        <path d="M4.5 7l2 2 3-3" stroke={s.icon} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    error: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke={s.icon} strokeWidth="1.2"/>
        <path d="M5 5l4 4M9 5l-4 4" stroke={s.icon} strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
    ),
    info: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke={s.icon} strokeWidth="1.2"/>
        <path d="M7 6.5v3.5M7 4.5v.5" stroke={s.icon} strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
    ),
  };

  return (
    <div
      onClick={() => onDismiss(item.id)}
      style={{
        pointerEvents: "auto",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        borderRadius: 8,
        background: s.bg,
        border: `1px solid ${s.border}`,
        boxShadow: "0 4px 24px rgba(0,0,0,0.3)",
        color: "#d4d0e0",
        fontSize: 13,
        fontWeight: 400,
        lineHeight: 1.4,
        maxWidth: 320,
        animation: "toast-slide-in 0.18s ease-out",
        letterSpacing: "0.01em",
      }}
    >
      {icons[item.type]}
      <span>{item.message}</span>
    </div>
  );
}
