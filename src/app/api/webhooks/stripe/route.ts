import prisma from "@/db/prisma";
import { stripe } from "@/lib/stripe";
import Stripe from "stripe";

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

export async function POST(req: Request) {
  const body = await req.text();

  const signature = req.headers.get("stripe-signature")!;
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, WEBHOOK_SECRET);
  } catch (error: any) {
    console.error(`Webhook signature verification failed`, error.message);
    return new Response(`Webhook Error: ${error.message}`, { status: 400 });
  }

  // Handle the event
  try {
    switch (event.type) {
      case "checkout.session.completed":
        const session = await stripe.checkout.sessions.retrieve(
          (event.data.object as Stripe.Checkout.Session).id,
          { expand: ["line_items"] }
        );

        const customerId = session.customer as string;
        const customerDetails = session.customer_details;

        // If customerDetails has email (if user pass the email)
        if (customerDetails?.email) {
          const user = await prisma.user.findUnique({
            where: { email: customerDetails.email },
          });

          if (!user) throw new Error(`User not found`);

          // User subscribes to the platform for the first time
          if (!user.customerId) {
            await prisma.user.update({
              where: { id: user.id },
              data: { customerId },
            });
          }

          const lineItems = session.line_items?.data || [];

          for (const item of lineItems) {
            // we had two: monthly & yearly
            const priceId = item.price?.id;

            // we check if this payment is a subscription or just one time payment
            const isSubscription = item.price?.type === "recurring";

            if (isSubscription) {
              let endDate = new Date();

              if (priceId === process.env.STRIPE_YEARLY_PRICE_ID!) {
                endDate.setFullYear(endDate.getFullYear() + 1); // 1 year from now
              } else if (priceId === process.env.STRIPE_MONTHLY_PRICE_ID!) {
                endDate.setMonth(endDate.getMonth() + 1); // 1 month from now
              } else {
                throw new Error(`Invalid priceId`);
              }

              // it's gonna create the subscription if it does not exist already, but if it exists it will update it
              await prisma.subscription.upsert({
                where: { userId: user.id! },
                //
                create: {
                  userId: user.id,
                  startDate: new Date(),
                  endDate: endDate,
                  plan: "premium",
                  period:
                    priceId === process.env.STRIPE_YEARLY_PRICE_ID!
                      ? "yearly"
                      : "monthly",
                },
                //
                update: {
                  plan: "premium",
                  period:
                    priceId === process.env.STRIPE_YEARLY_PRICE_ID!
                      ? "yearly"
                      : "monthly",
                  startDate: new Date(),
                  endDate: endDate,
                },
              });

              // we've created Subscription, it's time to update User field as well
              await prisma.user.update({
                where: { id: user.id },
                data: { plan: "premium" },
              });
            } else {
              // one_time_purchase
            }
          }
        }
        break;

      case "customer.subscription.deleted": {
        const subscription = await stripe.subscriptions.retrieve(
          (event.data.object as Stripe.Subscription).id
        );
        const user = await prisma.user.findUnique({
          where: { customerId: subscription.customer as string },
        });

        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: { plan: "free" },
          });
        } else {
          console.log(`User not found for the subscription deleted event.`);
          throw new Error(`User not found for the subscription deleted event.`);
        }
        break;
      }

      default:
        console.log(`Unhandled event type ${event.type}`);
    }
  } catch (error: any) {
    console.error(`Error handling event`, error);
    return new Response("Webhook Error", { status: 400 });
  }

  return new Response("Webhook received", { status: 200 });
}
