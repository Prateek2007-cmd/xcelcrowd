import { Link } from "wouter";
import { Building2, UserCheck, ArrowRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      {/* Header */}
      <div className="text-center mb-10 space-y-3">
        <div className="flex items-center justify-center gap-2 mb-4">
          <div className="w-4 h-4 bg-primary rounded-sm" />
          <h1 className="text-3xl font-bold text-primary tracking-tight font-mono">
            OPS_CENTER
          </h1>
        </div>
        <p className="text-muted-foreground text-lg max-w-md">
          Self-Moving Hiring Pipeline
        </p>
      </div>

      {/* Role Selection */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-2xl">
        {/* Company Card */}
        <Link
          href="/dashboard"
          onClick={() => {
            localStorage.setItem("user_role", "admin");
            localStorage.removeItem("applicant_email");
            localStorage.removeItem("applicant_name");
          }}
        >
          <Card className="group cursor-pointer border-border/50 bg-card/80 backdrop-blur hover:border-primary/40 transition-all duration-300 h-full">
            <CardHeader className="text-center pb-3">
              <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-3 group-hover:bg-primary/20 transition-colors">
                <Building2 className="w-7 h-7 text-primary" />
              </div>
              <CardTitle className="text-xl">Company</CardTitle>
              <CardDescription>
                Manage jobs, view pipelines, and track applicants.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <Button
                variant="ghost"
                className="w-full justify-between text-muted-foreground group-hover:text-primary transition-colors"
              >
                Go to Dashboard
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </Button>
            </CardContent>
          </Card>
        </Link>

        {/* Applicant Card */}
        <Link
          href="/apply"
          onClick={() => {
            localStorage.setItem("user_role", "applicant");
          }}
        >
          <Card className="group cursor-pointer border-border/50 bg-card/80 backdrop-blur hover:border-primary/40 transition-all duration-300 h-full">
            <CardHeader className="text-center pb-3">
              <div className="mx-auto w-14 h-14 rounded-full bg-emerald-500/10 flex items-center justify-center mb-3 group-hover:bg-emerald-500/20 transition-colors">
                <UserCheck className="w-7 h-7 text-emerald-500" />
              </div>
              <CardTitle className="text-xl">Applicant</CardTitle>
              <CardDescription>
                Apply for a position or check your application status.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <Button
                variant="ghost"
                className="w-full justify-between text-muted-foreground group-hover:text-emerald-500 transition-colors"
              >
                Apply Now
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </Button>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Footer hint */}
      <p className="text-xs text-muted-foreground mt-10">
        Already applied?{" "}
        <Link
          href="/status"
          className="text-primary hover:underline font-medium"
        >
          Check your status
        </Link>
      </p>
    </div>
  );
}
