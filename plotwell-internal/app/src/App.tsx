import { lazy, Suspense } from "react";
import { Routes, Route, NavLink, Navigate } from "react-router-dom";
import {
  PenLine,
  Share2,
  Mail,
  CalendarDays,
  ClipboardCheck,
  History,
  Clapperboard,
  Target,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Direct imports from tool source (no Module Federation needed)
const BlogApp = lazy(() => import("@tools/blog/App"));
const SocialApp = lazy(() => import("@tools/social/App"));
const SeoApp = lazy(() => import("@tools/seo/App"));
const SemApp = lazy(() => import("@tools/sem/App"));
const EmailApp = lazy(() => import("@tools/email/App"));
const AnalyticsApp = lazy(() => import("@tools/analytics/App"));
const CalendarApp = lazy(() => import("@tools/calendar/App"));
const AccountabilityApp = lazy(() => import("@tools/accountability/App"));
const HistoryApp = lazy(() => import("@tools/history/App"));
const MediaApp = lazy(() => import("@tools/media/App"));
const FocusApp = lazy(() => import("@tools/focus/App"));

interface ToolEntry {
  path: string;
  label: string;
  icon: LucideIcon;
}

interface SectionEntry {
  section: string;
}

type NavItem = ToolEntry | SectionEntry;

function isSection(item: NavItem): item is SectionEntry {
  return "section" in item;
}

const navItems: NavItem[] = [
  { section: "Content" },
  { path: "blog", label: "Blog", icon: PenLine },
  { path: "social", label: "Social", icon: Share2 },
  { path: "email", label: "Email", icon: Mail },
  { path: "calendar", label: "Calendar", icon: CalendarDays },
  { path: "media", label: "Media", icon: Clapperboard },
  { section: "Operations" },
  { path: "accountability", label: "Fiscal", icon: ClipboardCheck },
  { path: "focus", label: "Focus", icon: Target },
  { path: "history", label: "History", icon: History },
];

function Loading() {
  return (
    <div className="flex items-center justify-center py-20">
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: "50%",
          border: "2px solid #d97706",
          borderTopColor: "transparent",
          animation: "spin 0.7s linear infinite",
        }}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/** OAuth2 callback page - extracts token from URL hash and sends to parent */
function OAuthCallback() {
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  const accessToken = params.get("access_token");
  const expiresIn = params.get("expires_in");
  const error = params.get("error");

  if (window.opener) {
    window.opener.postMessage(
      {
        type: "google-oauth-callback",
        access_token: accessToken,
        expires_in: expiresIn,
        error: error || (accessToken ? null : "No token received"),
      },
      window.location.origin
    );
    window.close();
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <p style={{ fontSize: 13, color: "var(--text-tertiary)" }}>
        {error ? `Auth error: ${error}` : "Authenticating... You can close this window."}
      </p>
    </div>
  );
}

export default function App() {
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      {/* Sidebar */}
      <nav
        style={{
          width: 220,
          flexShrink: 0,
          background: "var(--sidebar-bg)",
          borderRight: "1px solid var(--sidebar-border)",
          display: "flex",
          flexDirection: "column",
          padding: "0",
        }}
      >
        {/* Brand */}
        <div
          style={{
            padding: "24px 20px 20px",
            borderBottom: "1px solid var(--sidebar-border)",
          }}
        >
          <div
            style={{
              fontFamily: "'Syne', sans-serif",
              fontSize: 16,
              fontWeight: 700,
              color: "#f5f4f0",
              letterSpacing: "-0.01em",
            }}
          >
            plotwell
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--sidebar-section)",
              marginTop: 2,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              fontWeight: 500,
            }}
          >
            internal
          </div>
        </div>

        {/* Nav */}
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: "12px 0",
            flex: 1,
          }}
        >
          {navItems.map((item, i) => {
            if (isSection(item)) {
              return (
                <li
                  key={item.section}
                  style={{
                    padding: i > 0 ? "20px 20px 6px" : "6px 20px 6px",
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: "var(--sidebar-section)",
                    }}
                  >
                    {item.section}
                  </span>
                </li>
              );
            }
            const Icon = item.icon;
            return (
              <li key={item.path} style={{ padding: "1px 8px" }}>
                <NavLink
                  to={`/${item.path}`}
                  style={({ isActive }) => ({
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 12px",
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: isActive ? 500 : 400,
                    color: isActive ? "var(--sidebar-text-active)" : "var(--sidebar-text)",
                    background: isActive ? "var(--sidebar-active)" : "transparent",
                    textDecoration: "none",
                    transition: "all 0.12s ease",
                    position: "relative",
                  })}
                  className="nav-link"
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span
                          style={{
                            position: "absolute",
                            left: 0,
                            top: "50%",
                            transform: "translateY(-50%)",
                            width: 2.5,
                            height: 16,
                            background: "var(--amber)",
                            borderRadius: "0 2px 2px 0",
                          }}
                        />
                      )}
                      <Icon
                        size={15}
                        strokeWidth={isActive ? 2 : 1.75}
                        style={{ color: isActive ? "var(--amber-light)" : "var(--sidebar-text)" }}
                      />
                      {item.label}
                    </>
                  )}
                </NavLink>
              </li>
            );
          })}
        </ul>

        {/* Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--sidebar-border)",
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: "var(--sidebar-section)",
              letterSpacing: "0.02em",
            }}
          >
            © 2026 plotwell
          </div>
        </div>
      </nav>

      {/* Content */}
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          background: "var(--bg)",
        }}
      >
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Navigate to="/blog" replace />} />
            <Route path="/blog/*" element={<BlogApp />} />
            <Route path="/social/*" element={<SocialApp />} />
            <Route path="/seo/*" element={<SeoApp />} />
            <Route path="/sem/*" element={<SemApp />} />
            <Route path="/email/*" element={<EmailApp />} />
            <Route path="/calendar/*" element={<CalendarApp />} />
            <Route path="/analytics/*" element={<AnalyticsApp />} />
            <Route path="/accountability/*" element={<AccountabilityApp />} />
            <Route path="/focus/*" element={<FocusApp />} />
            <Route path="/history/*" element={<HistoryApp />} />
            <Route path="/media/*" element={<MediaApp />} />
            <Route path="/oauth/callback" element={<OAuthCallback />} />
          </Routes>
        </Suspense>
      </main>

      <style>{`
        .nav-link:hover {
          background: var(--sidebar-hover) !important;
          color: #d0cfd8 !important;
        }
      `}</style>
    </div>
  );
}
