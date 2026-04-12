import { useLocation, Link } from "wouter";
import { Building, Users, PlayCircle } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const nav = [
    { href: "/", label: "Dashboard", icon: Building },
    { href: "/applicants", label: "Applicants", icon: Users },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <nav className="w-64 border-r border-border bg-card flex flex-col">
        <div className="p-4 border-b border-border">
          <h1 className="font-bold text-primary text-xl flex items-center gap-2 tracking-tight">
            <div className="w-3 h-3 bg-primary rounded-sm"></div>
            OPS_CENTER
          </h1>
        </div>
        <div className="flex-1 p-4 space-y-2">
          {nav.map((item) => {
            const active = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer text-sm font-medium ${
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  }`}
                >
                  <item.icon className="w-4 h-4" />
                  {item.label}
                </div>
              </Link>
            );
          })}
        </div>
      </nav>
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto p-8">{children}</div>
      </main>
    </div>
  );
}
