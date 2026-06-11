import type { ReactNode } from "react";
import { ToastProvider } from "./Toast";

interface ToolPageProps {
  title: string;
  description: string;
  children: ReactNode;
}

export function ToolPage({ title, description, children }: ToolPageProps) {
  return (
    <ToastProvider>
      <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
        {/* Page header */}
        <div
          style={{
            padding: "32px 40px 28px",
            borderBottom: "1px solid var(--border-subtle)",
            background: "var(--surface)",
          }}
        >
          <div style={{ maxWidth: 960, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <h1
                style={{
                  fontFamily: "'Syne', sans-serif",
                  fontSize: 22,
                  fontWeight: 700,
                  color: "var(--text-primary)",
                  margin: 0,
                  letterSpacing: "-0.02em",
                  lineHeight: 1,
                }}
              >
                {title}
              </h1>
              <span
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: "var(--amber)",
                  flexShrink: 0,
                  marginBottom: 2,
                }}
              />
            </div>
            <p
              style={{
                margin: "6px 0 0",
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.5,
              }}
            >
              {description}
            </p>
          </div>
        </div>

        {/* Content */}
        <div
          style={{
            maxWidth: 960,
            margin: "0 auto",
            padding: "32px 40px",
          }}
        >
          {children}
        </div>
      </div>
    </ToastProvider>
  );
}
