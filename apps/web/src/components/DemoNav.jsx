import { Link, useLocation } from 'react-router-dom';

const links = [
  { path: '/demo', label: 'Demo' },
  { path: '/demo-searches', label: 'Searches' },
  { path: '/demo-prompts', label: 'Prompts' },
  { path: '/demo-manual', label: 'Manual' },
];

export default function DemoNav() {
  const { pathname } = useLocation();

  return (
    <div className="border-b border-neutral-200 bg-white">
      <div className="max-w-3xl mx-auto px-6 flex items-center justify-between h-14">
        <Link to="/demo" className="text-base font-light italic tracking-tight text-neutral-900 hover:text-neutral-600 transition-colors">
          Runa Demo
        </Link>
        <nav className="flex items-center gap-1">
          {links.map(({ path, label }) => {
            const isDemoSubroute = pathname.startsWith('/demo/') && !links.some(l => l.path !== '/demo' && pathname === l.path);
            const isActive = pathname === path || (path === '/demo' && isDemoSubroute);
            return (
              <Link
                key={path}
                to={path}
                className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-neutral-900 text-white'
                    : 'text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50'
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
