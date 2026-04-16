import { Link, useLocation } from "wouter";
import { Bot, TerminalSquare, ShieldAlert } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Pairing", icon: Bot },
    { href: "/deploy", label: "Deploy", icon: TerminalSquare },
    { href: "/admin", label: "Admin", icon: ShieldAlert },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground dark selection:bg-primary/30 selection:text-primary">
      <header className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <div className="flex items-center gap-2 font-mono text-lg font-bold tracking-tight text-primary">
            <Bot className="h-6 w-6" />
            <span>NUTTER-XMD</span>
          </div>
          
          <nav className="flex items-center gap-6 text-sm font-medium">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2 transition-colors hover:text-primary ${
                  location === item.href ? "text-primary" : "text-muted-foreground"
                }`}
              >
                <item.icon className="h-4 w-4" />
                <span className="hidden sm:inline-block">{item.label}</span>
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-1 container py-8 relative">
        {/* Glow effect */}
        <div className="pointer-events-none fixed inset-0 flex justify-center">
          <div className="h-[500px] w-[500px] rounded-full bg-primary/5 blur-[120px] -translate-y-1/2" />
        </div>
        
        <div className="relative z-10">
          {children}
        </div>
      </main>

      <footer className="border-t border-border/50 py-6 md:py-0">
        <div className="container flex flex-col items-center justify-between gap-4 md:h-16 md:flex-row">
          <p className="text-sm text-muted-foreground">
            Built for NUTTER-XMD Multi-Device
          </p>
        </div>
      </footer>
    </div>
  );
}
