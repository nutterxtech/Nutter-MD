import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ShieldAlert, RefreshCw, GitFork, Github, Clock, Search, Lock } from "lucide-react";
import { useGetAdminForks, ApiError } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

const authSchema = z.object({
  password: z.string().min(1, { message: "Password is required" }),
});

export function AdminPage() {
  const [password, setPassword] = useState<string | null>(null);

  const form = useForm<z.infer<typeof authSchema>>({
    resolver: zodResolver(authSchema),
    defaultValues: {
      password: "",
    },
  });

  const { data, isLoading, isError, error, refetch } = useGetAdminForks({
    request: {
      headers: password ? { 'x-admin-password': password } : {}
    },
    query: {
      enabled: !!password,
      queryKey: ['admin-forks', password],
      retry: false,
    }
  });

  // We consider it an auth error if it's 401 or 403
  const isAuthError = isError && error instanceof ApiError && error.status === 401;

  function onSubmit(values: z.infer<typeof authSchema>) {
    setPassword(values.password);
  }

  function handleLogout() {
    setPassword(null);
    form.reset();
  }

  if (!password || isAuthError) {
    return (
      <div className="max-w-md mx-auto mt-12">
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader className="space-y-1 text-center">
            <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center text-primary mb-4">
              <Lock className="h-6 w-6" />
            </div>
            <CardTitle className="text-2xl font-bold tracking-tight">Admin Access</CardTitle>
            <CardDescription>Enter the admin password to view forks</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Input type="password" placeholder="••••••••" className="bg-background/50 text-center tracking-widest text-lg h-12" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                {isAuthError && (
                  <p className="text-sm font-medium text-destructive text-center">
                    Invalid password
                  </p>
                )}
                
                <Button type="submit" className="w-full h-12 font-bold" disabled={isLoading}>
                  {isLoading ? "Verifying..." : "Authenticate"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tighter flex items-center gap-2">
            <ShieldAlert className="h-8 w-8 text-primary" />
            Admin Dashboard
          </h1>
          <p className="text-muted-foreground">Monitor repository forks and deployments</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="px-3 py-1 font-mono text-sm bg-background">
            Total Forks: {data?.total || 0}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button variant="ghost" size="sm" onClick={handleLogout}>
            Logout
          </Button>
        </div>
      </div>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-[250px]">User</TableHead>
                <TableHead>Fork Repository</TableHead>
                <TableHead className="text-right">Date Forked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={3} className="h-32 text-center text-muted-foreground">
                    <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2 text-primary/50" />
                    Loading forks...
                  </TableCell>
                </TableRow>
              ) : !data?.forks || data.forks.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="h-32 text-center text-muted-foreground">
                    <GitFork className="h-8 w-8 mx-auto mb-2 opacity-20" />
                    No forks found yet
                  </TableCell>
                </TableRow>
              ) : (
                data.forks.map((fork) => (
                  <TableRow key={fork.id} className="hover:bg-muted/20">
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-9 w-9 border border-border">
                          <AvatarImage src={fork.avatarUrl} alt={fork.login} />
                          <AvatarFallback className="bg-primary/10 text-primary font-mono">
                            {fork.login.substring(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex flex-col">
                          <span className="font-medium text-foreground">{fork.login}</span>
                          <a 
                            href={fork.profileUrl} 
                            target="_blank" 
                            rel="noreferrer"
                            className="text-xs text-muted-foreground flex items-center hover:text-primary transition-colors"
                          >
                            <Github className="h-3 w-3 mr-1" />
                            Profile
                          </a>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <a 
                        href={fork.forkUrl} 
                        target="_blank" 
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm font-mono bg-muted/50 px-2 py-1 rounded hover:bg-primary/10 hover:text-primary transition-colors border border-border"
                      >
                        <GitFork className="h-3.5 w-3.5" />
                        {fork.login}/NUTTER-XMD
                      </a>
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      <div className="flex items-center justify-end gap-1.5">
                        <Clock className="h-3.5 w-3.5 opacity-50" />
                        {new Date(fork.createdAt).toLocaleDateString(undefined, { 
                          year: 'numeric', 
                          month: 'short', 
                          day: 'numeric' 
                        })}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
