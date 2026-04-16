import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Github, Rocket, Search, CheckCircle2, AlertCircle, ArrowRight } from "lucide-react";
import { useVerifyFork, ApiError, getVerifyForkQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const formSchema = z.object({
  username: z.string().min(1, { message: "GitHub username is required" }),
});

export function DeployPage() {
  const [username, setUsername] = useState<string | null>(null);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      username: "",
    },
  });

  const verifyParams = { username: username || "" };
  const { data: verificationData, isLoading, isError, error, refetch } = useVerifyFork(
    verifyParams,
    {
      query: {
        enabled: !!username,
        retry: false,
        queryKey: getVerifyForkQueryKey(verifyParams),
      }
    }
  );

  function onSubmit(values: z.infer<typeof formSchema>) {
    setUsername(values.username);
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="space-y-2 text-center mb-8">
        <h1 className="text-3xl font-bold tracking-tighter">Deploy Bot</h1>
        <p className="text-muted-foreground">Verify your fork and deploy to Heroku</p>
      </div>

      <div className="grid gap-6">
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/20 text-primary font-bold">1</div>
              <CardTitle>Verify Fork</CardTitle>
            </div>
            <CardDescription className="ml-10">You must fork the Nutter-MD repository before deploying</CardDescription>
          </CardHeader>
          <CardContent className="ml-10">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="flex gap-4">
                <FormField
                  control={form.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormControl>
                        <div className="relative">
                          <Github className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                          <Input placeholder="Enter your GitHub username" className="pl-9 bg-background/50" {...field} />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" disabled={isLoading}>
                  {isLoading ? <Search className="h-4 w-4 animate-bounce" /> : "Verify"}
                </Button>
              </form>
            </Form>

            {username && isLoading && (
              <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground animate-pulse">
                <Search className="h-4 w-4" /> Checking GitHub...
              </div>
            )}

            {username && isError && (
              <Alert variant="destructive" className="mt-6 bg-destructive/10 border-destructive/20">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Verification Failed</AlertTitle>
                <AlertDescription>
                  {error instanceof ApiError ? error.message : "Could not verify your GitHub account. Please try again."}
                </AlertDescription>
              </Alert>
            )}

            {verificationData && !verificationData.forked && (
              <Alert variant="destructive" className="mt-6 bg-destructive/10 border-destructive/20">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Fork Not Found</AlertTitle>
                <AlertDescription className="space-y-4 mt-2">
                  <p>User <strong>{verificationData.username}</strong> has not forked the Nutter-MD repository.</p>
                  <Button variant="outline" size="sm" asChild className="w-full sm:w-auto border-destructive/30 hover:bg-destructive/20">
                    <a href="https://github.com/nutterxtech/Nutter-MD" target="_blank" rel="noreferrer">
                      <Github className="mr-2 h-4 w-4" /> Go to Repository to Fork
                    </a>
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {verificationData && verificationData.forked && (
              <div className="mt-6 p-4 bg-green-500/10 border border-green-500/20 rounded-lg flex items-start gap-4 animate-in fade-in slide-in-from-bottom-2">
                <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-medium text-green-500">Fork Verified</h4>
                  <p className="text-sm text-green-500/80 mt-1">
                    Found fork at <a href={verificationData.forkUrl || "#"} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-green-400">{verificationData.forkUrl}</a>
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className={`border-border/50 bg-card/50 backdrop-blur-sm transition-all duration-300 ${(!verificationData || !verificationData.forked) ? 'opacity-50 grayscale select-none pointer-events-none' : ''}`}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/20 text-primary font-bold">2</div>
              <CardTitle>Deploy</CardTitle>
            </div>
            <CardDescription className="ml-10">Deploy your forked repository to Heroku</CardDescription>
          </CardHeader>
          <CardContent className="ml-10 space-y-6">
            <Alert className="bg-primary/5 border-primary/20">
              <AlertCircle className="h-4 w-4 text-primary" />
              <AlertTitle className="text-primary">Requirement</AlertTitle>
              <AlertDescription className="text-primary/80">
                You will need your <strong>SESSION_ID</strong> during deployment. Make sure you have paired your device on the Pairing page first.
              </AlertDescription>
            </Alert>
            
            <Button size="lg" className="w-full font-bold h-14 text-lg bg-[#430098] hover:bg-[#430098]/90 text-white border-0" asChild>
              <a 
                href={verificationData?.deployUrl || `https://heroku.com/deploy?template=https://github.com/${username}/Nutter-MD`} 
                target="_blank" 
                rel="noreferrer"
              >
                <Rocket className="mr-2 h-5 w-5" /> Deploy to Heroku <ArrowRight className="ml-2 h-5 w-5 opacity-50" />
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
