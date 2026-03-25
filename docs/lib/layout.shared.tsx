import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

// fill this with your actual GitHub info, for example:
export const gitConfig = {
  user: 'ddrscott',
  repo: 'relay-tty',
  branch: 'main',
};

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="font-mono font-bold">
          <span className="text-green-500">relay</span>
          <span className="text-fd-muted-foreground">-tty</span>
          <span className="text-fd-muted-foreground text-xs ml-2 font-normal">docs</span>
        </span>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links: [
      {
        text: 'relaytty.com',
        url: 'https://relaytty.com',
        external: true,
      },
    ],
  };
}
