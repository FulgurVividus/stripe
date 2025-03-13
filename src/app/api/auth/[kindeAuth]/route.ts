import { handleAuth } from "@kinde-oss/kinde-auth-nextjs/server";
// this will create all the endpoints that we'll need such as login, signup, log out and etc.

export const GET = handleAuth();
