import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { Copy, RefreshCw, QrCode, Hash, Smartphone, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";

const formSchema = z.object({
  phoneNumber: z.string().min(10, { message: "Enter a valid phone number" }).regex(/^\+?[1-9]\d{1,14}$/, { message: "Must be international format e.g. +254712345678" }),
});

export function HomePage() {
  const { toast } = useToast();
  const [mode, setMode] = useState<"code" | "qr">("code");
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairingToken, setPairingToken] = useState<string | null>(null);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      phoneNumber: "",
    },
  });

  const pairRequest = usePairRequest();
  const resetPairing = useResetPairing();

  const startQrSession = useStartQrPairing({
    mutation: {
      onSuccess: (data) => {
        if (data.pairingToken) setPairingToken(data.pairingToken);
      },
    },
  });

  // Query status repeatedly while pairing is active
  const { data: statusData, isLoading: isLoadingStatus } = useGetPairStatus({
    query: {
      refetchInterval: 2000,
      queryKey: getGetPairStatusQueryKey(),
    }
  });

  const status = statusData?.status || "idle";
  const isPairingActive = status !== "idle" && status !== "disconnected";
  const isConnected = status === "connected";

  // Fetch QR only if we're in QR mode and status is connecting/qr_ready
  const { data: qrData, isLoading: isLoadingQr } = useGetPairQr({
    query: {
      enabled: mode === "qr" && (status === "connecting" || status === "qr_ready"),
      queryKey: getGetPairQrQueryKey(),
      refetchInterval: 5000, // Refresh QR every 5s just in case
    }
  });

  // Fetch session once connected, using pairing token for access control
  const { data: sessionData, isLoading: isLoadingSession } = useQuery({
    queryKey: ["pair-session", pairingToken],
    enabled: isConnected && !!pairingToken,
    refetchInterval: 2000,
    queryFn: async () => {
      const r = await fetch("/api/pair/session", {
        headers: { "x-pairing-token": pairingToken! },
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({})) as { message?: string };
        throw new Error(data.message || `HTTP ${r.status}`);
      }
      return r.json() as Promise<{ sessionId: string; phoneNumber: string | null }>;
    },
  });

  async function onSubmit(values: z.infer<typeof formSchema>) {
    try {
      const res = await pairRequest.mutateAsync({
        data: { phoneNumber: values.phoneNumber }
      });
      setPairCode(res.pairCode);
      if (res.pairingToken) setPairingToken(res.pairingToken);
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
      setPairCode(null);
      setPairingToken(null);
      form.reset();
    } catch (err: unknown) {
      toast({
        variant: "destructive",
        title: "Error resetting",
        description: err instanceof ApiError ? err.message : "Failed to reset pairing",
      });
    }
  }

  function copyToClipboard(text: string, type: string) {
    navigator.clipboard.writeText(text);
    toast({
      title: "Copied!",
      description: `${type} copied to clipboard`,
    });
  }

  const renderStatusBadge = () => {
    switch (status) {
      case "idle":
        return <span className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-muted text-muted-foreground rounded-md"><AlertCircle className="w-3 h-3" /> Idle</span>;
      case "connecting":
        return <span className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-primary/10 text-primary border border-primary/20 rounded-md"><Loader2 className="w-3 h-3 animate-spin" /> Connecting</span>;
      case "qr_ready":
      case "pair_code_ready":
        return <span className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-primary/20 text-primary border border-primary/30 rounded-md"><Smartphone className="w-3 h-3" /> Awaiting Device</span>;
      case "connected":
        return <span className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-green-500/20 text-green-400 border border-green-500/30 rounded-md"><CheckCircle2 className="w-3 h-3" /> Connected</span>;
      case "disconnected":
        return <span className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-destructive/20 text-destructive border border-destructive/30 rounded-md"><AlertCircle className="w-3 h-3" /> Disconnected</span>;
      default:
        return null;
    }
  };

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div className="space-y-2 text-center mb-8">
        <h1 className="text-3xl font-bold tracking-tighter">Device Pairing</h1>
        <p className="text-muted-foreground">Link your WhatsApp account to deploy the bot</p>
      </div>

      <Card className="border-primary/20 shadow-lg shadow-primary/5 bg-card/50 backdrop-blur-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <div className="space-y-1">
            <CardTitle>Connection Status</CardTitle>
            <CardDescription>Current state of the Baileys session</CardDescription>
          </div>
          {renderStatusBadge()}
        </CardHeader>

        <CardContent>
          {isConnected ? (
            <div className="space-y-6 animate-in fade-in zoom-in duration-500">
              <div className="p-6 bg-primary/5 border border-primary/20 rounded-lg text-center space-y-4">
                <div className="mx-auto w-12 h-12 bg-primary/20 rounded-full flex items-center justify-center text-primary">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <h3 className="text-xl font-semibold text-primary">Successfully Linked</h3>
                <p className="text-sm text-muted-foreground">Your device is now connected. Copy your Session ID below to deploy.</p>
                
                <div className="mt-4 p-4 bg-background/50 rounded-md border border-border flex flex-col gap-2">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground text-left">Session ID</span>
                  <div className="flex gap-2">
                    {isLoadingSession ? (
                      <Skeleton className="h-10 flex-1" />
                    ) : (
                      <code className="flex-1 p-2 bg-muted rounded text-sm overflow-hidden text-ellipsis whitespace-nowrap font-mono text-primary/80">
                        {sessionData?.sessionId || 'Waiting for session data...'}
                      </code>
                    )}
                    <Button 
                      variant="secondary" 
                      size="icon"
                      onClick={() => {
                        if (sessionData?.sessionId) copyToClipboard(sessionData.sessionId, "Session ID");
                      }}
                      disabled={!sessionData?.sessionId}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
              <Button variant="outline" className="w-full" onClick={handleReset}>
                <RefreshCw className="w-4 h-4 mr-2" /> Start Over
              </Button>
            </div>
          ) : (
            <Tabs value={mode} onValueChange={(v) => setMode(v as "code" | "qr")} className="w-full">
              <TabsList className="grid w-full grid-cols-2 mb-6">
                <TabsTrigger value="code" disabled={isPairingActive && status !== "pair_code_ready"}>
                  <Hash className="w-4 h-4 mr-2" /> Pair Code
                </TabsTrigger>
                <TabsTrigger value="qr" disabled={isPairingActive && status !== "qr_ready"}>
                  <QrCode className="w-4 h-4 mr-2" /> QR Code
                </TabsTrigger>
              </TabsList>

              <TabsContent value="code" className="space-y-4">
                {!pairCode ? (
                  <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                      <FormField
                        control={form.control}
                        name="phoneNumber"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Phone Number</FormLabel>
                            <FormControl>
                              <Input placeholder="+254712345678" {...field} className="font-mono bg-background/50" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <Button type="submit" className="w-full font-bold" disabled={pairRequest.isPending || isPairingActive}>
                        {pairRequest.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                        Request Pair Code
                      </Button>
                    </form>
                  </Form>
                ) : (
                  <div className="space-y-6 text-center animate-in fade-in duration-300">
                    <div className="space-y-2">
                      <h3 className="text-lg font-medium">Your Pair Code</h3>
                      <p className="text-sm text-muted-foreground">Enter this code in WhatsApp linked devices</p>
                    </div>
                    
                    <div className="p-8 bg-muted/30 border border-border rounded-xl flex items-center justify-center group relative overflow-hidden">
                      <div className="absolute inset-0 bg-primary/5 group-hover:bg-primary/10 transition-colors" />
                      <div className="text-4xl md:text-5xl font-mono font-bold tracking-[0.2em] text-primary relative z-10 flex items-center gap-4">
                        {pairCode.slice(0,4)}-{pairCode.slice(4)}
                        <Button 
                          size="icon" 
                          variant="ghost" 
                          className="h-8 w-8 text-muted-foreground hover:text-primary"
                          onClick={() => copyToClipboard(pairCode, "Pair Code")}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <Button variant="outline" className="w-full" onClick={handleReset}>
                      Cancel & Reset
                    </Button>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="qr" className="space-y-4 text-center">
                {!isPairingActive ? (
                  <div className="py-12 border-2 border-dashed border-border rounded-lg bg-muted/10 space-y-4">
                    <QrCode className="w-12 h-12 mx-auto text-muted-foreground" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium">QR Code Pairing</p>
                      <p className="text-xs text-muted-foreground">Scan the QR code with WhatsApp Linked Devices to link your account.</p>
                    </div>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        startQrSession.mutate();
                      }}
                      disabled={startQrSession.isPending}
                    >
                      {startQrSession.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                      Start QR Session
                    </Button>
                    {startQrSession.isError && (
                      <p className="text-xs text-destructive">{startQrSession.error instanceof Error ? startQrSession.error.message : "Failed to start QR session"}</p>
                    )}
                  </div>
                ) : mode === "qr" && status === "connecting" ? (
                  <div className="py-12 border border-border rounded-lg bg-muted/10 flex flex-col items-center justify-center gap-4">
                    <Loader2 className="w-8 h-8 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground">Generating QR code...</p>
                    <Button variant="outline" className="w-full mt-4" onClick={handleReset}>Cancel</Button>
                  </div>
                ) : mode === "qr" && qrData?.qr ? (
                  <div className="space-y-4 animate-in zoom-in duration-300">
                    <div className="bg-white p-4 rounded-xl inline-block mx-auto border-4 border-primary/20">
                      <img src={qrData.qr} alt="WhatsApp QR Code" className="w-64 h-64" />
                    </div>
                    <p className="text-sm text-muted-foreground">Scan with WhatsApp Linked Devices</p>
                    <Button variant="outline" className="w-full" onClick={handleReset}>
                      Cancel & Reset
                    </Button>
                  </div>
                ) : (
                  <div className="py-12 border border-border rounded-lg bg-muted/10 flex flex-col items-center justify-center gap-4">
                    <Loader2 className="w-8 h-8 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground">Waiting for QR code...</p>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
