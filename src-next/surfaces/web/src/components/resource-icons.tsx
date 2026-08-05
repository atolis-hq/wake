import { faFileLines } from '@fortawesome/free-solid-svg-icons/faFileLines';
import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons/faArrowUpRightFromSquare';
import { faGithub } from '@fortawesome/free-brands-svg-icons/faGithub';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

interface IconProps {
  readonly className?: string;
}

export function GitHubIcon({ className }: IconProps) {
  return <FontAwesomeIcon icon={faGithub} className={className} aria-hidden="true" />;
}

export function DocumentIcon({ className }: IconProps) {
  return <FontAwesomeIcon icon={faFileLines} className={className} aria-hidden="true" />;
}

export function ExternalLinkIcon({ className }: IconProps) {
  return <FontAwesomeIcon icon={faArrowUpRightFromSquare} className={className} aria-hidden="true" />;
}
