import sharedPart0 from './factory.ts';
import sharedPart1 from './avatar-members.ts';
export default {
	...sharedPart0,
	...sharedPart1,
} as const;
