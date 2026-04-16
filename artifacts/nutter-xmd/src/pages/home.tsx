import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Copy, RefreshCw, QrCode, Hash, Loader2 } from "lucide-react";
import { ApiError } from "@workspace/api-client-react";
import {
  usePairRequest,
  useGetPairQr,
  useGetPairStatus,
  useResetPairing,
  useStartQrPairing,
  getGetPairQrQueryKey,
  getGetPairStatusQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";

const formSchema = z.object({
  phoneNumber: z
    .string()
    .min(10, { message: "Enter a valid phone number" })
    .regex(/^\+?[1-9]\d{1,14}$/, { message: "Must be international format e.g. +254712345678" }),
});

interface SessionResult {
  sessionId: string;
  phoneNumber: string | null;
}

export function HomePage() {
  const { toast } = useToast();
  const [mode, setMode] = useState<"code" | "qr">("code");

  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairingToken, setPairingToken] = useState<string | null>(null);
  const [qrActive, setQrActive] = useState(false);
  const [pairCodePending, setPairCodePending] = useState(false);

  const [sessionResult, setSessionResult] = useState<SessionResult | null>(null);
  const [isFetchingSession, setIsFetchingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { phoneNumber: "" },
  });

  const pairRequest = usePairRequest();
  const resetPairing = useResetPairing();

  const startQrSession = useStartQrPairing({
    mutation: {
      onSuccess: (data) => {
        if (data.pairingToken) setPairingToken(data.pairingToken);
        setQrActive(true);
      },
      onError: () => {
        setQrActive(false);
      },
    },
  });

  const { data: qrData, isLoading: isLoadingQr, isError: isQrError } = useGetPairQr({
    query: {
      enabled: qrActive,
      queryKey: getGetPairQrQueryKey(),
      // Once QR is visible refresh every 25s; while still connecting check every 2s
      refetchInterval: (query) => query.state.data?.qr ? 25000 : 2000,
      // Don't retry on error — server signals disconnected via 503; let user reset
      retry: false,
    },
  });

  // Poll /pair/status every 2s after submitting — stops once pair code arrives or session fails
  const { data: statusData } = useGetPairStatus({
    query: {
      enabled: pairCodePending,
      queryKey: getGetPairStatusQueryKey(),
      refetchInterval: 2000,
      retry: false,
    },
  });

  useEffect(() => {
    if (!statusData) return;
    if (statusData.pairCode && statusData.status === "pair_code_ready") {
      setPairCode(statusData.pairCode);
      setPairCodePending(false);
    } else if (statusData.status === "disconnected") {
      setPairCodePending(false);
      toast({
        variant: "destructive",
        title: "WhatsApp connection failed",
        description: "Could not reach WhatsApp. Try again or use QR code mode.",
      });
    }
  }, [statusData]);

  async function onSubmit(values: z.infer<typeof formSchema>) {
    try {
      const res = await pairRequest.mutateAsync({ data: { phoneNumber: values.phoneNumber } });
      if (res.pairingToken) setPairingToken(res.pairingToken);
      setSessionResult(null);
      setSessionError(null);
      setPairCode(null);
      setPairCodePending(true); // start polling /pair/status for the code
    } catch (err: unknown) {
      toast({
        variant: "destructive",
        title: "Error requesting pair code",
        description: err instanceof ApiError ? err.message : "Failed to initialize pairing",
      });
    }
  }

  async function handleReset() {
    try {
      await resetPairing.mutateAsync();
    } catch (_) {}
    setPairCode(null);
    setPairingToken(null);
    setQrActive(false);
    setPairCodePending(false);
    setSessionResult(null);
    setSessionError(null);
    form.reset();
  }

  async function fetchSessionId() {
    if (!pairingToken) return;
    setIsFetchingSession(true);
    setSessionError(null);
    try {
      const r = await fetch("/api/pair/session", {
        headers: { "x-pairing-token": pairingToken },
      });
      const data = await r.json() as { sessionId?: string; phoneNumber?: string | null; message?: string };
      if (!r.ok) {
        if (r.status === 202) {
          setSessionError("Not linked yet. Enter the code in WhatsApp first, then try again.");
        } else {
          setSessionError(data.message || "Session not available.");
        }
        return;
      }
      if (data.sessionId) {
        setSessionResult({ sessionId: data.sessionId, phoneNumber: data.phoneNumber ?? null });
      }
    } catch {
      setSessionError("Connection error. Please try again.");
    } finally {
      setIsFetchingSession(false);
    }
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied!", description: `${label} copied to clipboard` });
  }

  const showPairCodeStep = mode === "code" && !!pairCode;
  const showQrStep = mode === "qr" && qrActive;
  const showSessionStep = !sessionResult && (showPairCodeStep || showQrStep);

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div className="space-y-2 text-center mb-8">
        <h1 className="text-3xl font-bold tracking-tighter">Device Pairing</h1>
        <p className="text-muted-foreground">Link your WhatsApp account to get your Session ID</p>
      </div>

      <Card className="border-primary/20 shadow-lg shadow-primary/5 bg-card/50 backdrop-blur-sm">
        <CardHeader className="pb-4">
          <CardTitle>Step 1 — Link WhatsApp</CardTitle>
          <CardDescription>Choose a pairing method below</CardDescription>
        </CardHeader>

        <CardContent>
          {sessionResult ? (
            <div className="space-y-6 animate-in fade-in zoom-in duration-500">
              <div className="p-6 bg-primary/5 border border-primary/20 rounded-lg text-center space-y-4">
                <p className="text-sm font-medium text-primary">WhatsApp Linked Successfully</p>
                <div className="mt-2 p-4 bg-background/50 rounded-md border border-border flex flex-col gap-2">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground text-left">
                    Session ID
                  </span>
                  <div className="flex gap-2">
                    <code className="flex-1 p-2 bg-muted rounded text-sm overflow-hidden text-ellipsis whitespace-nowrap font-mono text-primary/80">
                      {sessionResult.sessionId}
                    </code>
                    <Button
                      variant="secondary"
                      size="icon"
                      onClick={() => copyToClipboard(sessionResult.sessionId, "Session ID")}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground text-left">
                    Paste this as your <code>SESSION_ID</code> when deploying to Heroku.
                  </p>
                </div>
              </div>
              <Button variant="outline" className="w-full" onClick={handleReset}>
                <RefreshCw className="w-4 h-4 mr-2" /> Pair Another Account
              </Button>
            </div>
          ) : (
            <Tabs
              value={mode}
              onValueChange={(v) => {
                if (!pairCode && !qrActive) setMode(v as "code" | "qr");
              }}
              className="w-full"
            >
              <TabsList className="grid w-full grid-cols-2 mb-6">
                <TabsTrigger value="code" disabled={qrActive}>
                  <Hash className="w-4 h-4 mr-2" /> Pair Code
                </TabsTrigger>
                <TabsTrigger value="qr" disabled={!!pairCode}>
                  <QrCode className="w-4 h-4 mr-2" /> QR Code
                </TabsTrigger>
              </TabsList>

              <TabsContent value="code" className="space-y-4">
                {!pairCode && !pairCodePending ? (
                  <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                      <FormField
                        control={form.control}
                        name="phoneNumber"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>WhatsApp Phone Number</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="+254712345678"
                                {...field}
                                className="font-mono bg-background/50"
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <Button
                        type="submit"
                        className="w-full font-bold"
                        disabled={pairRequest.isPending}
                      >
                        {pairRequest.isPending ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : null}
                        Get Pair Code
                      </Button>
                    </form>
                  </Form>
                ) : pairCodePending && !pairCode ? (
                  <div className="space-y-4 text-center animate-in fade-in duration-300">
                    <div className="p-10 bg-muted/30 border border-border rounded-xl flex flex-col items-center gap-4">
                      <Loader2 className="w-10 h-10 text-primary animate-spin" />
                      <p className="text-sm text-muted-foreground">Connecting to WhatsApp and generating your pair code…</p>
                      <p className="text-xs text-muted-foreground/60">May retry a few times — this is normal</p>
                    </div>
                    <Button variant="outline" size="sm" className="w-full" onClick={handleReset}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-6 text-center animate-in fade-in duration-300">
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">
                        Open WhatsApp → Linked Devices → Link a Device → enter this code:
                      </p>
                    </div>
                    <div className="p-8 bg-muted/30 border border-border rounded-xl flex items-center justify-center group relative overflow-hidden">
                      <div className="absolute inset-0 bg-primary/5 group-hover:bg-primary/10 transition-colors" />
                      <div className="text-4xl md:text-5xl font-mono font-bold tracking-[0.2em] text-primary relative z-10 flex items-center gap-4">
                        {pairCode}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-primary"
                          onClick={() => pairCode && copyToClipboard(pairCode, "Pair Code")}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" className="w-full" onClick={handleReset}>
                      Cancel & Start Over
                    </Button>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="qr" className="space-y-4 text-center">
                {!qrActive ? (
                  <div className="py-12 border-2 border-dashed border-border rounded-lg bg-muted/10 space-y-4">
                    <QrCode className="w-12 h-12 mx-auto text-muted-foreground" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Scan with WhatsApp</p>
                      <p className="text-xs text-muted-foreground">
                        Open WhatsApp → Linked Devices → Link a Device → scan the QR below.
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      onClick={() => startQrSession.mutate()}
                      disabled={startQrSession.isPending}
                    >
                      {startQrSession.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : null}
                      Generate QR Code
                    </Button>
                    {startQrSession.isError && (
                      <p className="text-xs text-destructive">
                        {startQrSession.error instanceof Error
                          ? startQrSession.error.message
                          : "Failed to start QR session"}
                      </p>
                    )}
                  </div>
                ) : isQrError ? (
                  <div className="py-10 border border-destructive/40 rounded-lg bg-destructive/5 flex flex-col items-center justify-center gap-4 text-center">
                    <p className="text-sm font-semibold text-destructive">WhatsApp connection failed</p>
                    <p className="text-xs text-muted-foreground max-w-xs">
                      The server couldn't reach WhatsApp after several attempts. Try again — it often succeeds on the next try.
                    </p>
                    <Button size="sm" onClick={handleReset}>Try Again</Button>
                  </div>
                ) : isLoadingQr || !qrData?.qr ? (
                  <div className="py-12 border border-border rounded-lg bg-muted/10 flex flex-col items-center justify-center gap-4">
                    <Loader2 className="w-8 h-8 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground">Connecting to WhatsApp…</p>
                    <p className="text-xs text-muted-foreground/60">This may take up to 30 seconds</p>
                    <Button variant="outline" size="sm" className="w-full mt-2" onClick={handleReset}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-4 animate-in zoom-in duration-300">
                    <div className="bg-white p-4 rounded-xl inline-block mx-auto border-4 border-primary/20">
                      <img src={qrData.qr} alt="WhatsApp QR Code" className="w-64 h-64" />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      QR refreshes automatically every 25 seconds
                    </p>
                    <Button variant="outline" size="sm" className="w-full" onClick={handleReset}>
                      Cancel & Start Over
                    </Button>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          )}
        </CardContent>
      </Card>

      {showSessionStep && (
        <Card className="border-primary/20 shadow-lg shadow-primary/5 bg-card/50 backdrop-blur-sm animate-in fade-in duration-300">
          <CardHeader className="pb-4">
            <CardTitle>Step 2 — Session ID Sent to You</CardTitle>
            <CardDescription>
              Your SESSION_ID has been sent directly to your WhatsApp. Check your messages from the
              linked number — the bot will have messaged you with the full ID and Heroku setup
              instructions. If you didn't receive it, use the button below to retrieve it manually.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              className="w-full font-bold"
              variant="outline"
              onClick={fetchSessionId}
              disabled={isFetchingSession}
            >
              {isFetchingSession ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              {isFetchingSession ? "Checking…" : "Didn't receive it? Get Session ID"}
            </Button>
            {sessionError && (
              <p className="text-sm text-destructive text-center">{sessionError}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
