import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import Dashboard from "@/pages/dashboard";
import ApplicantRegistry from "@/pages/applicant-registry";
import JobPipeline from "@/pages/job-pipeline";
import ApplicantDetail from "@/pages/applicant-detail";
import PipelineReplay from "@/pages/pipeline-replay";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/applicants" component={ApplicantRegistry} />
      <Route path="/applicants/:applicantId" component={ApplicantDetail} />
      <Route path="/jobs/:jobId" component={JobPipeline} />
      <Route path="/pipeline/:jobId/replay" component={PipelineReplay} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
