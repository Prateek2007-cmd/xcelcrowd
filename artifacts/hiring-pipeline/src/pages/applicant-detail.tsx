import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ArrowLeft, Briefcase, PlayCircle, CheckCircle, XCircle } from "lucide-react";

import {
  useGetApplicant,
  useGetApplicantStatus,
  useGetApplicantTimeline,
  useWithdrawApplication,
  useAcknowledgePromotion,
  getGetApplicantStatusQueryKey,
  getGetApplicantTimelineQueryKey,
} from "@workspace/api-client-react";

import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { Countdown } from "@/components/countdown";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";

export default function ApplicantDetail() {
  const { applicantId } = useParams<{ applicantId: string }>();
  const id = parseInt(applicantId || "0", 10);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: applicant, isLoading: applicantLoading } = useGetApplicant(id, {
    query: { enabled: !!id },
  });
  const { data: statusData, isLoading: statusLoading } = useGetApplicantStatus(id, {
    query: { enabled: !!id },
  });
  const { data: timeline, isLoading: timelineLoading } = useGetApplicantTimeline(id, {
    query: { enabled: !!id },
  });

  const withdrawMutation = useWithdrawApplication();
  const acknowledgeMutation = useAcknowledgePromotion();

  const handleWithdraw = (applicationId: number) => {
    withdrawMutation.mutate(
      { data: { applicationId } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetApplicantStatusQueryKey(id) });
          queryClient.invalidateQueries({ queryKey: getGetApplicantTimelineQueryKey(id) });
          toast({ title: "Application withdrawn" });
        },
        onError: () => {
          toast({ title: "Failed to withdraw", variant: "destructive" });
        },
      }
    );
  };

  const handleAcknowledge = (applicationId: number) => {
    acknowledgeMutation.mutate(
      { data: { applicationId } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetApplicantStatusQueryKey(id) });
          queryClient.invalidateQueries({ queryKey: getGetApplicantTimelineQueryKey(id) });
          toast({ title: "Promotion acknowledged successfully" });
        },
        onError: () => {
          toast({ title: "Failed to acknowledge", variant: "destructive" });
        },
      }
    );
  };

  if (applicantLoading || statusLoading || timelineLoading) {
    return (
      <Layout>
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </Layout>
    );
  }

  if (!applicant || !statusData) {
    return (
      <Layout>
        <div className="text-center py-12">
          <h2 className="text-2xl font-bold">Applicant not found</h2>
          <Link href="/applicants">
            <Button variant="link" className="mt-4">Back to Registry</Button>
          </Link>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/applicants">
            <Button variant="outline" size="icon" className="h-8 w-8 rounded-full">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h2 className="text-3xl font-bold tracking-tight">{applicant.name}</h2>
            <p className="text-muted-foreground font-mono text-sm mt-1">{applicant.email}</p>
          </div>
        </div>

        <div className="space-y-6">
            <Card className="border-border/50">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Briefcase className="h-5 w-5 text-primary" /> Active Applications
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {statusData.applications.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground border rounded-lg border-dashed">
                      No active applications found.
                    </div>
                  ) : (
                    statusData.applications.map((app) => (
                      <div key={app.applicationId} className="border rounded-lg p-4 bg-card/50">
                        <div className="flex items-start justify-between">
                          <div>
                            <Link href={`/jobs/${app.jobId}`} className="text-lg font-semibold hover:underline flex items-center gap-2">
                              {app.jobTitle}
                            </Link>
                            <div className="flex items-center gap-3 mt-2">
                              <StatusBadge status={app.status} />
                              {app.status === "WAITLIST" && app.queuePosition !== null && (
                                <span className="text-sm font-mono bg-amber-500/10 text-amber-500 px-2 py-0.5 rounded border border-amber-500/20">
                                  POS #{app.queuePosition}
                                </span>
                              )}
                              <span className="text-xs text-muted-foreground font-mono">
                                App ID: {app.applicationId}
                              </span>
                            </div>
                          </div>
                          <div className="flex flex-col gap-2">
                            {app.status === "PENDING_ACKNOWLEDGMENT" && (
                              <Button
                                size="sm"
                                className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-[0_0_15px_rgba(16,185,129,0.3)] animate-pulse"
                                onClick={() => handleAcknowledge(app.applicationId)}
                                disabled={acknowledgeMutation.isPending}
                              >
                                <CheckCircle className="mr-2 h-4 w-4" /> Acknowledge Spot
                              </Button>
                            )}
                            {app.status !== "INACTIVE" && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-red-500 border-red-500/20 hover:bg-red-500/10 hover:text-red-500"
                                onClick={() => handleWithdraw(app.applicationId)}
                                disabled={withdrawMutation.isPending}
                              >
                                <XCircle className="mr-2 h-4 w-4" /> Remove from Pipeline
                              </Button>
                            )}
                          </div>
                        </div>

                        {app.status === "PENDING_ACKNOWLEDGMENT" && (
                          <div className="mt-4 p-3 bg-red-500/5 border border-red-500/20 rounded text-sm flex justify-between items-center">
                            <span className="text-red-400 font-medium">Spot offered! Acknowledgment required.</span>
                            <Countdown deadline={app.acknowledgeDeadline} />
                          </div>
                        )}
                        
                        <div className="mt-4 pt-4 border-t text-xs text-muted-foreground flex justify-between font-mono">
                          <span>Applied: {format(new Date(app.appliedAt), "MMM d, yyyy HH:mm")}</span>
                          {app.timeInCurrentStateSeconds !== undefined && (
                            <span>Time in state: {Math.floor(app.timeInCurrentStateSeconds / 60)}m</span>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className="border-border/50">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <PlayCircle className="h-5 w-5 text-muted-foreground" /> Event Timeline
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-0 relative before:absolute before:inset-0 before:ml-4 before:-translate-x-px md:before:ml-[5.5rem] md:before:translate-x-0 before:h-full before:w-0.5 before:bg-border">
                  {timeline?.length === 0 ? (
                    <div className="text-center py-4 text-muted-foreground ml-12">No events recorded.</div>
                  ) : (
                    timeline?.map((event, index) => (
                      <div key={event.id} className="relative flex items-start gap-4 mb-6 last:mb-0">
                        <div className="md:w-20 shrink-0 text-right text-xs font-mono text-muted-foreground pt-1 hidden md:block">
                          {format(new Date(event.createdAt), "MMM d\nHH:mm")}
                        </div>
                        <div className="absolute left-0 md:static flex items-center justify-center w-8 h-8 rounded-full bg-card border shadow z-10 shrink-0 mt-0.5">
                          <div className="w-2.5 h-2.5 rounded-full bg-primary" />
                        </div>
                        <div className="ml-10 md:ml-0 flex-1 pt-1">
                          <div className="text-sm font-semibold mb-1 text-foreground flex items-center gap-2">
                            {event.eventType.replace(/_/g, ' ')}
                            <span className="font-mono text-xs text-muted-foreground font-normal">App #{event.applicationId}</span>
                          </div>
                          {(event.fromStatus || event.toStatus) && (
                            <div className="flex items-center gap-2 mt-2">
                              {event.fromStatus && <StatusBadge status={event.fromStatus} />}
                              {event.fromStatus && event.toStatus && <span className="text-muted-foreground">→</span>}
                              {event.toStatus && <StatusBadge status={event.toStatus} />}
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
        </div>
      </div>
    </Layout>
  );
}
