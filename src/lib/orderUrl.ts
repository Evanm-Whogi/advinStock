export function buildOrderUrl(productId: number): string {
	const url = new URL('https://console.advinservers.com/order');
	if (Number.isInteger(productId) && productId > 0) {
		url.searchParams.set('pid', String(productId));
	}
	url.searchParams.set('aid', '109');
	return url.toString();
}
