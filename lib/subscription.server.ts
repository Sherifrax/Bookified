import { currentUser } from "@clerk/nextjs/server";
import { PLANS, type PlanType } from "@/lib/subscription-constants";

/** Resolve the signed-in user's plan from Clerk-managed public metadata. */
export const getUserPlan = async (): Promise<PlanType> => {
    const user = await currentUser();
    const metadataPlan = (user?.publicMetadata?.plan ?? user?.publicMetadata?.billingPlan)
        ?.toString()
        .toLowerCase();

    if (metadataPlan === PLANS.PRO) return PLANS.PRO;
    if (metadataPlan === PLANS.STANDARD) return PLANS.STANDARD;
    return PLANS.FREE;
};
