import { useState } from "react";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, BarChart3, Activity } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useListJobs,
  useCreateJob,
  getListJobsQueryKey,
} from "@workspace/api-client-react";

import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Progress } from "@/components/ui/progress";

const createJobSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  capacity: z.coerce.number().min(1, "Capacity must be at least 1"),
});

type CreateJobFormValues = z.infer<typeof createJobSchema>;

export default function Dashboard() {
  const { data: jobs, isLoading } = useListJobs();
  const createJob = useCreateJob();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const form = useForm<CreateJobFormValues>({
    resolver: zodResolver(createJobSchema),
    defaultValues: {
      title: "",
      description: "",
      capacity: 5,
    },
  });

  const onSubmit = (values: CreateJobFormValues) => {
    createJob.mutate(
      { data: values },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
          toast({ title: "Job created successfully" });
          setOpen(false);
          form.reset();
        },
        onError: () => {
          toast({ title: "Failed to create job", variant: "destructive" });
        },
      }
    );
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Dashboard</h2>
            <p className="text-muted-foreground mt-1">
              Active pipelines and job capacities.
            </p>
          </div>

          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" /> Create Job
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Job</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="title"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Job Title</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. Senior Backend Engineer" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="description"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Description (Optional)</FormLabel>
                        <FormControl>
                          <Textarea placeholder="Brief job description..." {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="capacity"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Active Capacity</FormLabel>
                        <FormControl>
                          <Input type="number" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="flex justify-end pt-4">
                    <Button type="submit" disabled={createJob.isPending}>
                      {createJob.isPending ? "Creating..." : "Create Job"}
                    </Button>
                  </div>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>

        {isLoading ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="animate-pulse">
                <CardHeader className="h-24 bg-muted/50"></CardHeader>
                <CardContent className="h-32"></CardContent>
              </Card>
            ))}
          </div>
        ) : jobs?.length === 0 ? (
          <div className="text-center py-12 border rounded-lg border-dashed">
            <h3 className="text-lg font-medium">No jobs found</h3>
            <p className="text-muted-foreground mt-1">Create your first job to start.</p>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {jobs?.map((job) => {
              const occupancyPercentage = job.capacity > 0 ? Math.min(100, Math.round((job.activeCount / job.capacity) * 100)) : 0;
              return (
                <Card key={job.id} className="flex flex-col border-primary/20 bg-card/50 backdrop-blur">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      <span className="truncate">{job.title}</span>
                      <Activity className="h-4 w-4 text-primary" />
                    </CardTitle>
                    <CardDescription className="line-clamp-2 min-h-10">
                      {job.description || "No description provided."}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex-1">
                    <div className="space-y-4">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Active Slots</span>
                          <span className="font-mono text-primary font-medium">
                            {job.activeCount} / {job.capacity}
                          </span>
                        </div>
                        <Progress value={occupancyPercentage} className="h-2" />
                      </div>
                      <div className="flex justify-between items-center text-sm border-t border-border/50 pt-4">
                        <span className="text-muted-foreground">Waitlist</span>
                        <span className="font-mono font-medium">{job.waitlistCount} applicants</span>
                      </div>
                    </div>
                  </CardContent>
                  <CardFooter className="bg-primary/5 border-t border-border/50">
                    <Link href={`/jobs/${job.id}`} className="w-full">
                      <Button variant="ghost" className="w-full justify-between hover:bg-primary/10 hover:text-primary">
                        View Pipeline <BarChart3 className="h-4 w-4" />
                      </Button>
                    </Link>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
}
