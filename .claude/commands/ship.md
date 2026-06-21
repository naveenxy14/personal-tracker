# Ship — commit, push, and deploy to Vercel

Stage all changes, create a commit, push to GitHub, then deploy to Vercel production.

## Steps

1. Run `git add .` to stage everything
2. Run `git diff --cached --stat` to show what's being committed
3. Look at `git log --oneline -3` to match the commit style
4. Write a concise commit message summarising the changes (1-2 sentences, present tense)
5. Commit with that message (include Co-Authored-By trailer)
6. Run `git push`
7. Deploy to Vercel: run `vercel --prod --yes` using Node 20 (`nvm use 20 && vercel --prod --yes`)
8. Report the Vercel URL when done

## Rules
- Never use `--no-verify`
- If git push fails (not up to date), run `git pull --rebase` first then push again
- The Vercel project is `personal-tracker` aliased to `personal-tracker-nk.vercel.app`
