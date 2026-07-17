import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { FlaskConical, LogOut, Settings, Users } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/tester', label: 'Prompt Tester', icon: FlaskConical },
  { to: '/users', label: 'Users', icon: Users },
];

export function Layout({ children }: { children: ReactNode }) {
  const { me, signOut } = useAuth();

  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-6 py-3">
        <div className="flex items-center gap-6">
          <span className="text-sm font-semibold">Scandi Admin Control</span>
          <nav className="flex items-center gap-1">
            {NAV.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-secondary text-secondary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )
                }
              >
                <Icon className="size-4" />
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground hidden text-sm sm:inline">
            {me?.email}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            <LogOut className="size-4" />
            Sign out
          </Button>
        </div>
      </header>
      <main className="flex-1 px-6 py-6">{children}</main>
    </div>
  );
}
