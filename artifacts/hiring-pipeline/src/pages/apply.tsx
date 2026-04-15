import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, useLocation } from "wouter";
import {
  Send,
  CheckCircle2,
  Copy,
  ArrowRight,
  Briefcase,
  Loader2,
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const applySchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Enter a valid email"),
  jobId: z.string().min(1, "Select a job"),
});

type ApplyFormValues = z.infer<typeof applySchema>;

interface SuccessData {
  applicantId: number;
  applicationId: number;
  jobTitle: string;
  status: string;
  queuePosition: number | null;
  message: string;
}

export default function ApplyPage() {
  const { data: jobs, isLoading: jobsLoading } = useListJobs();

  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [success, setSuccess] = useState<SuccessData | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  const form = useForm<ApplyFormValues>({
    resolver: zodResolver(applySchema),
    defaultValues: { name: "", email: "", jobId: "" },
  });

  const onSubmit = async (values: ApplyFormValues) => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/apply-public", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.name,
          email: values.email,
          jobId: Number(values.jobId),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        // Extract error message from backend { error: { message, code } } format
        const msg =
          data?.error?.message || data?.message || "Something went wrong";
        throw new Error(msg);
      }

      const selectedJob = jobs?.find((j) => j.id === Number(values.jobId));

      // Save credentials for seamless dashboard access
      localStorage.setItem("applicant_name", values.name);
      localStorage.setItem("applicant_email", values.email);

      setSuccess({
        applicantId: data.applicantId,
        applicationId: data.applicationId,
        jobTitle: selectedJob?.title ?? `Job #${values.jobId}`,
        status: data.status,
        queuePosition: data.queuePosition ?? null,
        message: data.message ?? "Application submitted.",
      });

      // Auto-redirect to dashboard after brief delay
      setTimeout(() => {
        navigate(`/status?id=${data.applicantId}`);
      }, 2000);
    } catch (err: unknown) {
      const description =
        err instanceof Error ? err.message : "Something went wrong";
      toast({
        title: "Application failed",
        description,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const copyId = () => {
    if (success) {
      navigator.clipboard.writeText(String(success.applicantId));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Copied to clipboard" });
    }
  };

  // ── Success View ──
  if (success) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md border-primary/30 bg-card/80 backdrop-blur">
          <CardHeader className="text-center pb-2">
            <div className="mx-auto w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
            </div>
            <CardTitle className="text-2xl">Application Submitted!</CardTitle>
            <CardDescription className="text-base mt-1">
              {success.message}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Applicant ID highlight */}
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-center space-y-2">
              <p className="text-sm text-muted-foreground font-medium">
                Your Applicant ID
              </p>
              <div className="flex items-center justify-center gap-3">
                <span className="text-4xl font-bold font-mono text-primary tracking-wider">
                  {success.applicantId}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={copyId}
                  className="text-muted-foreground hover:text-primary"
                >
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
              {copied && (
                <p className="text-xs text-emerald-500">Copied!</p>
              )}
              <p className="text-xs text-muted-foreground">
                ⚠️ Save this ID — you&apos;ll need it to check your status
              </p>
            </div>

            {/* Application details */}
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Position</span>
                <span className="font-medium">{success.jobTitle}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-primary/10 text-primary uppercase tracking-wider">
                  {success.status}
                </span>
              </div>
              {success.queuePosition !== null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Queue Position</span>
                  <span className="font-mono font-medium">
                    #{success.queuePosition}
                  </span>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-2 pt-2">
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Redirecting to your dashboard...</span>
              </div>
              <Button
                onClick={() => navigate(`/status?id=${success.applicantId}`)}
                variant="ghost"
                className="w-full text-primary"
              >
                Go now <ArrowRight className="ml-2 w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setSuccess(null);
                  form.reset();
                }}
                className="w-full text-muted-foreground"
              >
                Submit Another Application
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Apply Form ──
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md border-border/50 bg-card/80 backdrop-blur">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-3">
            <Briefcase className="w-6 h-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">Apply for a Position</CardTitle>
          <CardDescription>
            Fill in your details and select a job to apply.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-5"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Full Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Jane Doe" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email Address</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder="jane@example.com"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="jobId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Select Job</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue
                            placeholder={
                              jobsLoading ? "Loading jobs..." : "Choose a position"
                            }
                          />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {jobs?.map((job) => (
                          <SelectItem key={job.id} value={String(job.id)}>
                            {job.title}
                          </SelectItem>
                        ))}
                        {jobs?.length === 0 && (
                          <div className="p-3 text-sm text-muted-foreground text-center">
                            No open positions
                          </div>
                        )}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button
                type="submit"
                className="w-full"
                disabled={submitting || jobsLoading}
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <Send className="mr-2 h-4 w-4" />
                    Submit Application
                  </>
                )}
              </Button>
            </form>
          </Form>

          <p className="text-center text-xs text-muted-foreground mt-6">
            Already applied?{" "}
            <Link
              href="/status"
              className="text-primary hover:underline font-medium"
            >
              Check your status
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
