import { Outlet, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSuperAdmin } from '../context/SuperAdminContext';

const aiToolsNavigation = [
  { 
    name: 'AI Merchant', 
    path: '/ai-merchant',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    )
  },
  { 
    name: 'AI Visual Merchandiser', 
    path: '/ai-visual-merchandiser',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    )
  },
  { 
    name: 'AI Stylist', 
    path: '/ai-stylist',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
      </svg>
    )
  },
  { 
    name: 'AI Studio', 
    path: '/ai-studio',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
      </svg>
    )
  },
  { 
    name: 'AI Custom', 
    path: '/ai-custom',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.5 9.5L11 12l1.5-2.5L14 12" />
      </svg>
    )
  },
  { 
    name: 'AI Config', 
    path: '/ai-config',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
      </svg>
    )
  }
];

const settingsNavigation = [
  { 
    name: 'Store', 
    path: '/',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    )
  },
  { 
    name: 'Profile', 
    path: '/settings',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
    )
  }
];

export default function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const { isSuperAdmin, disableSuperAdmin } = useSuperAdmin();

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* Top Navigation Bar */}
      <header className="border-b border-neutral-100 flex-shrink-0">
        <div className="flex items-center justify-between h-16 px-8">
          {/* Logo */}
          <Link to="/" className="flex items-center">
            <span className="text-lg font-medium tracking-tight">RUNA</span>
            <span className="ml-2 text-xs text-neutral-400 tracking-wide">ADMIN</span>
          </Link>

          {/* User Menu */}
          <div className="flex items-center space-x-6">
            <p className="text-xs text-neutral-900 hidden sm:block">{user?.name}</p>
            {isSuperAdmin && (
              <button
                onClick={disableSuperAdmin}
                className="text-xs text-orange-500 hover:text-orange-700 transition-colors"
              >
                Disable Superadmin
              </button>
            )}
            <button
              onClick={logout}
              className="text-xs text-neutral-400 hover:text-neutral-900 tracking-wide uppercase transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* Main Layout with Sidebar */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar */}
        <aside className="w-64 border-r border-neutral-100 flex-shrink-0 hidden lg:flex lg:flex-col">
          <div className="flex-1 overflow-y-auto py-6 px-4">
            {/* AI Tools Section */}
            <p className="text-2xs font-medium uppercase text-neutral-400 tracking-widest px-4 mb-4">
              AI Tools
            </p>
            <nav className="space-y-1">
              {aiToolsNavigation.map((item) => {
                const isActive = location.pathname === item.path ||
                  location.pathname.startsWith(item.path + '/');

                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={`flex items-center gap-3 px-4 py-3 text-sm transition-all duration-200 rounded-sm ${
                      isActive
                        ? 'bg-neutral-900 text-white'
                        : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900'
                    }`}
                  >
                    <span className={isActive ? 'text-white' : 'text-neutral-400'}>
                      {item.icon}
                    </span>
                    <span className="font-medium">{item.name}</span>
                  </Link>
                );
              })}
            </nav>

            {/* Settings Section */}
            <p className="text-2xs font-medium uppercase text-neutral-400 tracking-widest px-4 mb-4 mt-8">
              Settings
            </p>
            <nav className="space-y-1">
              {settingsNavigation.map((item) => {
                const isActive = item.path === '/' 
                  ? location.pathname === '/'
                  : location.pathname === item.path || location.pathname.startsWith(item.path + '/');

                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={`flex items-center gap-3 px-4 py-3 text-sm transition-all duration-200 rounded-sm ${
                      isActive
                        ? 'bg-neutral-900 text-white'
                        : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900'
                    }`}
                  >
                    <span className={isActive ? 'text-white' : 'text-neutral-400'}>
                      {item.icon}
                    </span>
                    <span className="font-medium">{item.name}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </aside>

        {/* Mobile Sidebar - Horizontal scroll */}
        <div className="lg:hidden border-b border-neutral-100 overflow-x-auto flex-shrink-0 w-full absolute">
          <nav className="flex px-4 py-3 space-x-4">
            {[...aiToolsNavigation, ...settingsNavigation].map((item) => {
              const isActive = item.path === '/' 
                ? location.pathname === '/'
                : location.pathname === item.path || location.pathname.startsWith(item.path + '/');

              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`flex items-center gap-2 px-3 py-2 text-xs whitespace-nowrap rounded-sm transition-colors ${
                    isActive
                      ? 'bg-neutral-900 text-white'
                      : 'bg-neutral-50 text-neutral-600'
                  }`}
                >
                  {item.icon}
                  <span>{item.name}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Main Content */}
        <main className="flex-1 overflow-auto">
          <div className="max-w-6xl mx-auto px-8 py-12 lg:pt-12 pt-20">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Footer */}
      <footer className="border-t border-neutral-100 py-6 px-8 flex-shrink-0">
        <div className="max-w-7xl mx-auto flex items-center justify-between text-xs text-neutral-400">
          <p>© {new Date().getFullYear()} Runa AI. All rights reserved.</p>
          <a
            href="https://www.askruna.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-neutral-900 transition-colors"
          >
            askruna.ai
          </a>
        </div>
      </footer>
    </div>
  );
}
