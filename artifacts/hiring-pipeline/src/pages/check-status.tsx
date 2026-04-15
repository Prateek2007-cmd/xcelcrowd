import { useState, useEffect } from "react";
import { Link } from "wouter";
import {
  Search,
  User,
  Briefcase,
  Clock,
  Loader2,
  AlertCircle,
  Hash,
  LogOut,
  Plus,
  Info,
  Send,
} from "lucide-react";

import { useListJobs } from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/status-badge";
import { useToast } from "@/hooks/use-toast";

// ── Types ──────────────────────────────────────────

interface ApplicationEntry {
  applicationId: number;
  jobId: number;
  jobTitle: string;
  status: string;
  queuePosition: number | null;
  appliedAt: string;
  promotedAt: string | null;
  acknowledgeDeadline: string | null;
  timeInCurrentStateSeconds?: number;
}

interface ApplicantData {
  applicantId: number;
  applicantName: string;
  applicantEmail: string;
  applications: ApplicationEntry[];
}

// ── Helpers ────────────────────────────────────────

function formatTimeAgo(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ── Application Card ───────────────────────────────

function ApplicationCard({
  app,
  onWithdraw,
  withdrawingId,
}: {
  app: ApplicationEntry;
  onWithdraw: (id: number) => void;
  withdrawingId: number | null;
}) {
  const isInactive = app.status === "INACTIVE";
  const isWithdrawing = withdrawingId === app.applicationId;

  return (
    <div className="rounded-lg border border-border/50 bg-card/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Briefcase className="w-4 h-4 text-muted-foreground" />
          <span className="font-medium text-sm">{app.jobTitle}</span>
        </div>
        <StatusBadge status={app.status} />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        {app.queuePosition != null && (
          <div className="flex flex-col">
            <span className="text-muted-foreground">Queue Position</span>
            <span className="font-mono font-semibold text-primary text-lg">
              #{app.queuePosition}
            </span>
          </div>
        )}
        <div className="flex flex-col">
          <span className="text-muted-foreground">Applied</span>
          <span className="font-medium">
            {new Date(app.appliedAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </span>
        </div>
        {app.promotedAt && (
          <div className="flex flex-col">
            <span className="text-muted-foreground">Promoted</span>
            <span className="font-medium">
              {new Date(app.promotedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </div>
        )}
        {app.acknowledgeDeadline && (
          <div className="flex flex-col">
            <span className="text-muted-foreground">Ack Deadline</span>
            <span className="font-medium text-red-400">
              {new Date(app.acknowledgeDeadline).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </div>
        )}
        {app.timeInCurrentStateSeconds != null && (
          <div className="flex flex-col">
            <span className="text-muted-foreground">In Current State</span>
            <span className="font-medium">
              {formatTimeAgo(app.timeInCurrentStateSeconds)}
            </span>
          </div>
        )}
      </div>

      {!isInactive && (
        <div className="pt-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={isWithdrawing}
            onClick={() => onWithdraw(app.applicationId)}
            className="text-destructive hover:text-destructive hover:bg-destructive/10 text-xs w-full"
          >
            {isWithdrawing ? (
              <>
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                Withdrawing...
              </>
            ) : (
              <>
                <LogOut className="mr-1.5 h-3 w-3" />
                Withdraw Application
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────

export default function CheckStatusPage() {
  const { toast } = useToast();

  // Restore session from localStorage
  const savedEmail =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("applicant_email") ?? ""
      : "";
  const savedName =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("applicant_name") ?? ""
      : "";

  const [name, setName] = useState(savedName);
  const [email, setEmail] = useState(savedEmail);
  const [loggedIn, setLoggedIn] = useState(false);
  const [applicant, setApplicant] = useState<ApplicantData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<number | null>(null);
  const [wasRestored, setWasRestored] = useState(false);

  // Apply-to-job state
  const [selectedJobId, setSelectedJobId] = useState("");
  const [applying, setApplying] = useState(false);
  const { data: jobs, isLoading: jobsLoading } = useListJobs();

  // Auto-login from localStorage on mount
  useEffect(() => {
    if (savedEmail && savedName && !loggedIn) {
      setWasRestored(true);
      handleLogin(savedName, savedEmail);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Core: lookup applicant by email ──────────────

  async function handleLogin(loginName: string, loginEmail: string) {
    setLoading(true);
    setError(null);
    try {
      // Find applicant by email from the list
      const res = await fetch("/api/applicants");
      if (!res.ok) throw new Error("Failed to fetch applicants");
      const allApplicants = await res.json();
      const found = allApplicants.find(
        (a: { email: string }) =>
          a.email.toLowerCase() === loginEmail.toLowerCase()
      );

      if (!found) {
        // Create the applicant
        const createRes = await fetch("/api/applicants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: loginName, email: loginEmail }),
        });
        if (!createRes.ok) {
          const errData = await createRes.json();
          throw new Error(
            errData?.error?.message || "Could not create applicant"
          );
        }
        const created = await createRes.json();
        // No applications yet, show empty dashboard
        setApplicant({
          applicantId: created.id,
          applicantName: created.name,
          applicantEmail: created.email,
          applications: [],
        });
      } else {
        // Fetch full status for this applicant
        const statusRes = await fetch(`/api/status/${found.id}`);
        if (!statusRes.ok) throw new Error("Failed to load status");
        const data = await statusRes.json();
        setApplicant(data);
      }

      // Save to localStorage
      localStorage.setItem("applicant_email", loginEmail);
      localStorage.setItem("applicant_name", loginName);
      setLoggedIn(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function refreshDashboard() {
    if (!applicant) return;
    try {
      const res = await fetch(`/api/status/${applicant.applicantId}`);
      if (!res.ok) return;
      const data = await res.json();
      setApplicant(data);
    } catch {
      // silently fail refresh
    }
  }

  // ── Handlers ─────────────────────────────────────

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    handleLogin(name.trim(), email.trim());
  };

  const handleWithdraw = async (applicationId: number) => {
    setWithdrawingId(applicationId);
    try {
      const res = await fetch("/api/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.error?.message || data?.message || "Withdraw failed"
        );
      }
      toast({
        title: "Application withdrawn",
        description:
          data?.message || "Your application has been withdrawn successfully.",
      });
      await refreshDashboard();
    } catch (err: unknown) {
      toast({
        title: "Withdraw failed",
        description:
          err instanceof Error ? err.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setWithdrawingId(null);
    }
  };

  const handleApply = async () => {
    if (!selectedJobId || !applicant) return;
    setApplying(true);
    try {
      const res = await fetch("/api/apply-public", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: applicant.applicantName,
          email: applicant.applicantEmail,
          jobId: Number(selectedJobId),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.error?.message || data?.message || "Application failed"
        );
      }
      toast({
        title: "Application submitted!",
        description: data?.message || "You have applied successfully.",
      });
      setSelectedJobId("");
      await refreshDashboard();
    } catch (err: unknown) {
      toast({
        title: "Application failed",
        description:
          err instanceof Error ? err.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setApplying(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("applicant_email");
    localStorage.removeItem("applicant_name");
    setLoggedIn(false);
    setApplicant(null);
    setName("");
    setEmail("");
    setWasRestored(false);
  };

  // Split active vs inactive
  const activeApps =
    applicant?.applications.filter((a) => a.status !== "INACTIVE") ?? [];
  const inactiveApps =
    applicant?.applications.filter((a) => a.status === "INACTIVE") ?? [];

  // Jobs the applicant hasn't applied to (or has withdrawn from)
  const appliedJobIds = new Set(
    activeApps.map((a) => a.jobId)
  );
  const availableJobs = jobs?.filter((j) => !appliedJobIds.has(j.id)) ?? [];

  // ── Render ───────────────────────────────────────

  // Not logged in — show login form
  if (!loggedIn) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6">
          <Card className="border-border/50 bg-card/80 backdrop-blur">
            <CardHeader className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                <User className="w-6 h-6 text-primary" />
              </div>
              <CardTitle className="text-2xl">Applicant Dashboard</CardTitle>
              <CardDescription>
                Enter your name and email to view &amp; manage your
                applications.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Full Name</label>
                  <Input
                    type="text"
                    placeholder="Jane Doe"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Email Address</label>
                  <Input
                    type="email"
                    placeholder="jane@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <Button
                  type="submit"
                  disabled={loading || !name || !email}
                  className="w-full"
                >
                  {loading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    <>
                      <Search className="mr-2 h-4 w-4" />
                      View My Applications
                    </>
                  )}
                </Button>
              </form>

              {error && (
                <div className="mt-4 flex items-center gap-2 text-destructive text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <p className="text-center text-xs text-muted-foreground mt-4">
                New here?{" "}
                <Link
                  href="/apply"
                  className="text-primary hover:underline font-medium"
                >
                  Apply for a position
                </Link>
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // ── Dashboard view ───────────────────────────────

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-4">
        {/* Session restored hint */}
        {wasRestored && (
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Info className="w-3 h-3" />
            <span>Welcome back! We&apos;ve loaded your previous session.</span>
          </div>
        )}

        {/* Applicant Header */}
        {applicant && (
          <Card className="border-primary/20 bg-card/80 backdrop-blur">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <User className="w-5 h-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-lg truncate">
                    {applicant.applicantName}
                  </CardTitle>
                  <CardDescription className="truncate">
                    {applicant.applicantEmail}
                  </CardDescription>
                </div>
                <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                  <Hash className="w-3 h-3" />
                  <span className="font-mono">{applicant.applicantId}</span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Stats */}
              <div className="flex gap-4 text-xs">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-emerald-500" />
                  <span className="text-muted-foreground">
                    {activeApps.length} active
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-zinc-500" />
                  <span className="text-muted-foreground">
                    {inactiveApps.length} withdrawn
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">
                    {applicant.applications.length} total
                  </span>
                </div>
              </div>

              {/* Switch account */}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLogout}
                className="text-xs text-muted-foreground w-full"
              >
                Switch account
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Apply to a new job */}
        {availableJobs.length > 0 && (
          <Card className="border-border/50 bg-card/50">
            <CardContent className="pt-5">
              <p className="text-sm font-medium mb-3 flex items-center gap-2">
                <Plus className="w-4 h-4 text-primary" />
                Apply to a new job
              </p>
              <div className="flex gap-2">
                <Select
                  value={selectedJobId}
                  onValueChange={setSelectedJobId}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Choose a position" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableJobs.map((job) => (
                      <SelectItem key={job.id} value={String(job.id)}>
                        {job.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  disabled={!selectedJobId || applying}
                  onClick={handleApply}
                >
                  {applying ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Loading */}
        {loading && (
          <Card className="border-border/50 bg-card/50">
            <CardContent className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-primary animate-spin" />
              <span className="ml-3 text-muted-foreground">
                Loading your applications...
              </span>
            </CardContent>
          </Card>
        )}

        {/* Applications list */}
        {applicant && !loading && (
          <>
            {applicant.applications.length === 0 ? (
              <Card className="border-border/50 bg-card/50">
                <CardContent className="text-center py-10 text-muted-foreground text-sm">
                  <Clock className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>No applications yet.</p>
                  <p className="text-xs mt-1">
                    Select a job above to submit your first application!
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {activeApps.map((app) => (
                  <ApplicationCard
                    key={app.applicationId}
                    app={app}
                    onWithdraw={handleWithdraw}
                    withdrawingId={withdrawingId}
                  />
                ))}

                {inactiveApps.length > 0 && (
                  <>
                    {activeApps.length > 0 && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2">
                        <div className="h-px flex-1 bg-border/50" />
                        <span>Withdrawn</span>
                        <div className="h-px flex-1 bg-border/50" />
                      </div>
                    )}
                    {inactiveApps.map((app) => (
                      <div key={app.applicationId} className="opacity-50">
                        <ApplicationCard
                          app={app}
                          onWithdraw={handleWithdraw}
                          withdrawingId={withdrawingId}
                        />
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
