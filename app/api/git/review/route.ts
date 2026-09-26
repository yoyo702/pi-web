import { NextRequest, NextResponse } from "next/server";
import { buildReviewPrompt, getStagedDiffForReview, parseReviewAnswer } from "@/lib/git-precheck";
import { validateGitCwd } from "@/lib/git-request";
import type { GitAiReviewResponse } from "@/lib/git-types";
import { errorResponse } from "@/lib/http-error";
import { completeWithDefaultModel } from "@/lib/pi-default-model";

export const dynamic = "force-dynamic";

/** An AI summary of the staged changes, asked for explicitly by the user. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { cwd?: string };
    const invalid = await validateGitCwd(body.cwd);
    if (invalid) return NextResponse.json({ error: invalid.error }, { status: invalid.status });
    const cwd = (body.cwd as string).trim();
    const staged = await getStagedDiffForReview(cwd);
    const { text, provider, modelId } = await completeWithDefaultModel(cwd, {
      purpose: "reviewing changes",
      maxTokens: 800,
      prompt: buildReviewPrompt(staged.diff, staged.truncated),
    });
    const review: GitAiReviewResponse = { ...parseReviewAnswer(text), stagedFingerprint: staged.stagedFingerprint, provider, modelId, truncated: staged.truncated };
    return NextResponse.json(review);
  } catch (error) {
    return errorResponse(error);
  }
}
