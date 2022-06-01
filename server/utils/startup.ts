import chalk from "chalk";
import env from "@server/env";
import Logger from "@server/logging/Logger";
import AuthenticationProvider from "@server/models/AuthenticationProvider";
import Team from "@server/models/Team";

export async function checkMigrations() {
  if (env.DEPLOYMENT === "hosted") {
    return;
  }

  const teams = await Team.count();
  const providers = await AuthenticationProvider.count();

  if (teams && !providers) {
    Logger.warn(`
This version of Outline cannot start until a data migration is complete.
Backup your database, run the database migrations and the following script:

$ node ./build/server/scripts/20210226232041-migrate-authentication.js
`);
    process.exit(1);
  }
}

export async function checkEnv() {
  await env.validate().then((errors) => {
    if (errors.length > 0) {
      Logger.warn(
        "Environment configuration is invalid, please check the following:\n\n"
      );
      for (const error of errors) {
        Logger.warn("- " + Object.values(error.constraints ?? {}).join(", "));
      }
      process.exit(1);
    }
  });

  if (env.ENVIRONMENT === "production") {
    Logger.info(
      "lifecycle",
      chalk.green(`
Is your team enjoying Outline? Consider supporting future development by sponsoring the project:\n\nhttps://github.com/sponsors/outline
`)
    );
  } else if (env.ENVIRONMENT === "development") {
    Logger.warn(
      `Running Outline in ${chalk.bold(
        "development mode"
      )}. To run Outline in production mode set the ${chalk.bold(
        "NODE_ENV"
      )} env variable to "production"`
    );
  }
}
