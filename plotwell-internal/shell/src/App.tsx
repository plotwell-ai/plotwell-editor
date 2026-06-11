import { lazy, Suspense } from "react";
import { Routes, Route, NavLink, Navigate } from "react-router-dom";

const MediaApp          = lazy(() => import("media/App"));
const BlogApp           = lazy(() => import("blog/App"));
const SocialApp         = lazy(() => import("social/App"));
const EmailApp          = lazy(() => import("email/App"));
const AccountabilityApp = lazy(() => import("accountability/App"));
const FocusApp          = lazy(() => import("focus/App"));

const tools = [
  { path: "media",          label: "Media",          icon: "📸" },
  { path: "blog",           label: "Blog",            icon: "✏️" },
  { path: "social",         label: "Social",          icon: "📱" },
  { path: "email",          label: "Email",           icon: "📧" },
  { path: "accountability", label: "Fiscal",           icon: "💼" },
  { path: "focus",          label: "Focus",            icon: "🎯" },
];

function Loading() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
    </div>
  );
}

export default function App() {
  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <nav className="w-56 shrink-0 border-r border-gray-200 bg-white px-3 py-6">
        <div className="mb-8 px-3">
          <h1 className="text-lg font-bold text-gray-900">plotwell</h1>
          <p className="text-xs text-gray-400">internal tools</p>
        </div>
        <ul className="space-y-1">
          {tools.map((tool) => (
            <li key={tool.path}>
              <NavLink
                to={`/${tool.path}`}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-amber-50 text-amber-700"
                      : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                  }`
                }
              >
                <span>{tool.icon}</span>
                {tool.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Content */}
      <main className="flex-1 overflow-y-auto">
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/"                   element={<Navigate to="/media" replace />} />
            <Route path="/media/*"            element={<MediaApp />} />
            <Route path="/blog/*"             element={<BlogApp />} />
            <Route path="/social/*"           element={<SocialApp />} />
            <Route path="/email/*"            element={<EmailApp />} />
            <Route path="/accountability/*"   element={<AccountabilityApp />} />
            <Route path="/focus/*"            element={<FocusApp />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
