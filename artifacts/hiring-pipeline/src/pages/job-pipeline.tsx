import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { ArrowLeft, Clock, History, AlertCircle, ListOrdered, FastForward } from "lucide-react";

import {
  useGetJob,
  useGetPipelineSummary,
  useGetJobQueue,
} from "@workspace/api-client-react";

import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { Countdown } from "@/components/countdown";
import { Separator } from "@/components/ui/separator";

export default function JobPipeline() {
  const { jobId } = useParams<{ jobId: string }>();
  const id = parseInt(jobId || "0", 10);

  const { data: job, isLoading: jobLoading } = useGetJob(id, {
    query: { enabled: !!id },
  });
  const { data: summary, isLoading: summaryLoading } = useGetPipelineSummary(id, {
    query: { enabled: !!id },
  });
  const { data: queue, isLoading: queueLoading } = useGetJobQueue(id, {
    query: { enabled: !!id },
  });

  if (jobLoading || summaryLoading || queueLoading) {
    return (
      <Layout>
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </Layout>
    );
  }

  if (!job) {
    return (
      <Layout>
        <div className="text-center py-12">
          <h2 className="text-2xl font-bold">Job not found</h2>
          <Link href="/">
            <Button variant="link" className="mt-4">Back to Dashboard</Button>
          </Link>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/">
            <Button variant="outline" size="icon" className="h-8 w-8 rounded-full">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex-1">
            <h2 className="text-3xl font-bold tracking-tight flex items-center gap-3">
              {job.title}
              <StatusBadge status="ACTIVE" />
            </h2>
            <div className="text-muted-foreground mt-1 flex items-center gap-4 text-sm font-mono">
              <span>CAPACITY: {job.activeCount} / {job.capacity}</span>
              <span>•</span>
              <span>WAITLIST: {job.waitlistCount}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <Link href={`/pipeline/${id}/replay`}>
              <Button variant="outline" className="gap-2">
                <History className="h-4 w-4" /> Replay Timeline
              </Button>
            </Link>
          </div>
        </div>

        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
            <Card className="bg-card border-border/50">
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground mb-1 uppercase font-semibold tracking-wider">Total Apps</div>
                <div className="text-2xl font-bold font-mono">{summary.totalApplications}</div>
              </CardContent>
            </Card>
            <Card className="bg-card border-border/50">
              <CardContent className="p-4">
                <div className="text-xs text-emerald-500 mb-1 uppercase font-semibold tracking-wider">Active</div>
                <div className="text-2xl font-bold font-mono">{summary.activeCount}</div>
              </CardContent>
            </Card>
            <Card className="bg-card border-border/50">
              <CardContent className="p-4">
                <div className="text-xs text-amber-500 mb-1 uppercase font-semibold tracking-wider">Waitlist</div>
                <div className="text-2xl font-bold font-mono">{summary.waitlistCount}</div>
              </CardContent>
            </Card>
            <Card className="bg-card border-border/50">
              <CardContent className="p-4">
                <div className="text-xs text-gray-400 mb-1 uppercase font-semibold tracking-wider">Inactive</div>
                <div className="text-2xl font-bold font-mono">{summary.inactiveCount}</div>
              </CardContent>
            </Card>
            <Card className="bg-card border-border/50 bg-primary/5">
              <CardContent className="p-4">
                <div className="text-xs text-primary mb-1 uppercase font-semibold tracking-wider">Decay Events</div>
                <div className="text-2xl font-bold font-mono text-primary">{summary.decayEvents}</div>
              </CardContent>
            </Card>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="space-y-4">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <FastForward className="h-5 w-5 text-emerald-500" /> Active Roster
            </h3>
            <Card className="border-border/50">
              <div className="divide-y divide-border/50">
                {job.activeApplicants.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground">
                    No active applicants.
                  </div>
                ) : (
                  job.activeApplicants.map((app) => (
                    <div key={app.applicationId} className="p-4 flex items-center justify-between hover:bg-muted/20">
                      <div>
                        <div className="font-medium flex items-center gap-2">
                          <Link href={`/applicants/${app.applicantId}`} className="hover:underline text-foreground">
                            {app.applicantName}
                          </Link>
                          <StatusBadge status={app.status} />
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 font-mono">
                          {app.applicantEmail}
                        </div>
                      </div>
                      <div className="text-right">
                        {app.status === "PENDING_ACKNOWLEDGMENT" ? (
                          <div className="flex flex-col items-end gap-1">
                            <span className="text-xs text-muted-foreground">Deadline</span>
                            <Countdown deadline={app.acknowledgeDeadline} />
                          </div>
                        ) : (
                          <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
                            <span>Promoted</span>
                            <span className="font-mono">{app.promotedAt ? formatDistanceToNow(new Date(app.promotedAt)) + ' ago' : '-'}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>

          <div className="space-y-4">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <ListOrdered className="h-5 w-5 text-amber-500" /> Waitlist Queue
            </h3>
            <Card className="border-border/50">
              <div className="divide-y divide-border/50">
                {queue?.waitlistEntries.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground">
                    Waitlist is empty.
                  </div>
                ) : (
                  queue?.waitlistEntries.map((entry) => (
                    <div key={entry.applicationId} className="p-4 flex items-center gap-4 hover:bg-muted/20">
                      <div className="w-8 h-8 rounded bg-card border flex items-center justify-center font-mono font-bold text-amber-500 shrink-0">
                        {entry.position}
                      </div>
                      <div className="flex-1">
                        <div className="font-medium flex items-center gap-2">
                          <Link href={`/applicants/${entry.applicantId}`} className="hover:underline text-foreground">
                            {entry.applicantName}
                          </Link>
                          {entry.penaltyCount > 0 && (
                            <span className="text-xs font-mono text-orange-400 bg-orange-400/10 px-1 rounded border border-orange-400/20" title="Missed acknowledgment penalties">
                              {entry.penaltyCount} PENALTIES
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 flex items-center gap-3 font-mono">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatDistanceToNow(new Date(entry.appliedAt))} ago
                          </span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </Layout>
  );
}
